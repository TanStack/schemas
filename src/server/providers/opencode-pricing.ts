/**
 * OpenCode Zen prices from OpenCode's own console models page (issue #314).
 * Token rows are the Pricing table. Image models are the Image pricing
 * table (issue #100007). Embedding models are the Embedding pricing table,
 * input tokens only (issue #774). It is the only Zen price source: models.dev
 * `cost` is not read, and an id the page does not price states no price.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

/** Source of https://opencode.ai/docs/console/models/; markdown tables parse more stably than the rendered HTML. */
export const OPENCODE_PRICING_URL =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/services/site/src/docs/content/console/models.mdx'

const PRICE_HEADER = ['Model', 'Input', 'Output', 'Cached Read', 'Cached Write']
const IMAGE_HEADER = ['Model', 'Price', 'Notes']
const EMBEDDING_HEADER = ['Model', 'Input']
const PRICE_LEVERS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
] as const

/** `$1.00 / image` plus token add-ons, as the Image pricing notes state them. */
const PER_IMAGE = /^\$(\d+(?:\.\d+)?) \/ image$/
const IMAGE_TOKEN_NOTES =
  /^Plus \$(\d+(?:\.\d+)?) \/ \$(\d+(?:\.\d+)?) per 1M input \/ output tokens, and \$(\d+(?:\.\d+)?) per 1M cached input tokens\.$/
/** Input / text output / image output. An "About …" clause is an approximation, not a rate. */
const TOKEN_TRIPLE =
  /^\$(\d+(?:\.\d+)?) \/ \$(\d+(?:\.\d+)?) \/ \$(\d+(?:\.\d+)?) per 1M tokens$/
const TOKEN_TRIPLE_NOTES =
  /^Input \/ text output \/ image output\.(?: About \$\d+(?:\.\d+)? per 1K image, \$\d+(?:\.\d+)? per 2K, \$\d+(?:\.\d+)? per 4K\.)?$/
/**
 * A floor per image, a per-input-image fee, and a higher output band with
 * no quality or resolution rule. That row is unverified: no card.
 */
const UNRULED_BAND_NOTES =
  /^\$(\d+(?:\.\d+)?) per input image; quality and resolution can raise the output price to \$(\d+(?:\.\d+)?)(?:–|-)\$(\d+(?:\.\d+)?)\.$/

export interface OpenCodePricingDoc {
  text: string
  hash: string
  extractedAt: string
}

/** Page rates, USD per 1M tokens, keyed by rate-card lever (`input_tokens`, …). */
export type OpenCodeCost = Record<string, number>

function sameKeys(a: object, b: object): boolean {
  const left = Object.keys(a).sort().join()
  return left === Object.keys(b).sort().join()
}

/**
 * Page rates (USD per 1M) with an optional context tier → card. Throws on
 * missing input or output, a tier with other levers, or a zero base with a
 * tier. An all-zero base with no tier is a sourced free card.
 */
export function compileOpenCodeCost(
  base: OpenCodeCost,
  tiers: Array<{ minPromptTokens: number; rates: OpenCodeCost }>,
  id: string,
  source: RateCard['source'],
): RateCard {
  if (base.input_tokens === undefined || base.output_tokens === undefined) {
    throw new Error(`opencode: price for ${id} omits input or output`)
  }
  const perToken = (rates: OpenCodeCost) =>
    Object.fromEntries(
      Object.entries(rates).map(([lever, rate]) => [lever, rate / 1e6]),
    )
  const tokenTiers: Array<TokenRateTier> = tiers.map((tier) => {
    if (!sameKeys(base, tier.rates)) {
      throw new Error(`opencode: price tier for ${id} changes the levers`)
    }
    return {
      minPromptTokens: tier.minPromptTokens,
      rates: perToken(tier.rates),
    }
  })
  const rates = perToken(base)
  if (Object.values(rates).every((rate) => rate === 0)) {
    if (tiers.length > 0) {
      throw new Error(`opencode: zero base rate with a tier for ${id}`)
    }
    return {
      inputs: Object.fromEntries(
        Object.keys(rates).map((lever) => [
          lever,
          {
            param: lever,
            bound: 'usage',
            kind: 'number',
            ...(!['input_tokens', 'output_tokens'].includes(lever)
              ? { default: 0 }
              : {}),
          },
        ]),
      ),
      tables: { rate: { base: rates } },
      price: 0,
      examples: [],
      source,
    }
  }
  const card = compileTokenCard(rates, tokenTiers, source)
  if (!card) throw new Error(`opencode: unreadable price for ${id}`)
  return card
}

/** `$ per image` added to a token card. The count has no default: 1 would be a guess. */
function addPerImage(card: RateCard, usdEach: number): RateCard {
  const tokenPrice = card.price
  if (typeof tokenPrice !== 'object' || 'currency' in tokenPrice) {
    throw new Error('opencode: image prices are USD')
  }
  return {
    ...card,
    inputs: {
      num_images: { param: 'num_images', bound: 'usage', kind: 'number' },
      ...card.inputs,
    },
    price: { '+': [{ '*': [{ var: 'num_images' }, usdEach] }, tokenPrice] },
  }
}

function imageRowUnreadable(name: string): Error {
  return new Error(`opencode: unreadable image price row ${name}`)
}

/**
 * One Image pricing row. A shape this does not recognise throws.
 * `'unverified'` is an explicit absence: the row was read, and no card
 * is stored because a price would be a fallback.
 */
function compileImagePrice(
  name: string,
  priceCell: string,
  notes: string,
  source: RateCard['source'],
): RateCard | 'unverified' {
  const triple = TOKEN_TRIPLE.exec(priceCell)
  if (triple) {
    if (!TOKEN_TRIPLE_NOTES.test(notes)) throw imageRowUnreadable(name)
    return compileOpenCodeCost(
      {
        input_tokens: Number(triple[1]),
        output_tokens: Number(triple[2]),
        image_output_tokens: Number(triple[3]),
      },
      [],
      name,
      source,
    )
  }
  const each = PER_IMAGE.exec(priceCell)
  if (!each) throw imageRowUnreadable(name)
  const withTokens = IMAGE_TOKEN_NOTES.exec(notes)
  if (withTokens) {
    return addPerImage(
      compileOpenCodeCost(
        {
          input_tokens: Number(withTokens[1]),
          output_tokens: Number(withTokens[2]),
          cache_read_tokens: Number(withTokens[3]),
        },
        [],
        name,
        source,
      ),
      Number(each[1]),
    )
  }
  const unruled = UNRULED_BAND_NOTES.exec(notes)
  if (!unruled) throw imageRowUnreadable(name)
  const low = Number(unruled[2])
  const high = Number(unruled[3])
  if (!(low < high)) throw imageRowUnreadable(name)
  // The floor and the per-input-image fee are stated, and so is a higher
  // output band. Nothing maps quality or resolution onto that band, so a
  // card at $0.04 would bill every request at a price the page says can
  // be higher. Same outcome as a FAL extract that returns unverified.
  return 'unverified'
}

/** Cells of the first markdown table under `##` or `### <heading>`. `###` may be absent. */
function sectionTable(
  page: string,
  heading: string,
  level?: 2,
): Array<Array<string>>
function sectionTable(
  page: string,
  heading: string,
  level: 3,
): Array<Array<string>> | null
function sectionTable(
  page: string,
  heading: string,
  level: 2 | 3 = 2,
): Array<Array<string>> | null {
  const text = `\n${page}`
  const start = text.indexOf(`\n${'#'.repeat(level)} ${heading}\n`)
  if (start < 0) {
    if (level === 3) return null
    throw new Error(`opencode: pricing page has no ${heading}`)
  }
  const rows: Array<Array<string>> = []
  for (const line of text
    .slice(start + 1)
    .split('\n')
    .slice(1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
  }
  // Header, then the `| --- |` separator.
  if (rows.length < 3 || !rows[1]!.every((cell) => /^:?-+:?$/.test(cell))) {
    throw new Error(`opencode: pricing page ${heading} table is unreadable`)
  }
  return rows
}

/** `Free` → 0, `-` → not billed, `$1.40` → 1.4, `~~$1.36~~ $0.68` → the billed 0.68. */
function usd(value: string, name: string): number | undefined {
  if (value === '-') return undefined
  if (value === 'Free') return 0
  const match = /^(?:~~\$\d+(?:\.\d+)?~~\s+)?\$(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) throw new Error(`opencode: unreadable price ${value} for ${name}`)
  return Number(match[1])
}

/** Listed id → card. Joins Pricing and Image pricing to the Endpoints table by model name. */
export function parseOpenCodePricing(
  doc: OpenCodePricingDoc,
): Map<string, RateCard> {
  const endpoints = sectionTable(doc.text, 'Endpoints')
  if (endpoints[0]![0] !== 'Model' || endpoints[0]![1] !== 'Model ID') {
    throw new Error('opencode: pricing page Endpoints header changed')
  }
  const idByName = new Map<string, string>()
  for (const [name, id] of endpoints.slice(2)) {
    if (!name || !id || idByName.has(name)) {
      throw new Error(`opencode: unreadable endpoint row ${name}`)
    }
    idByName.set(name, id)
  }

  const priced = sectionTable(doc.text, 'Pricing')
  if (priced[0]!.join('|') !== PRICE_HEADER.join('|')) {
    throw new Error('opencode: pricing page Pricing header changed')
  }
  const rows = new Map<
    string,
    { base?: OpenCodeCost; over?: OpenCodeCost; upTo?: number; from?: number }
  >()
  for (const [label, ...cells] of priced.slice(2)) {
    if (!label || cells.length !== PRICE_LEVERS.length) {
      throw new Error(`opencode: unreadable price row ${label}`)
    }
    // `(50% off)` names a discount; the cell already shows the billed price.
    const plain = label.replace(/\s*\(\d+% off\)$/, '')
    const tier = /^(.*?)\s*\((≤|>) (\d+)K tokens\)$/.exec(plain)
    const name = tier ? tier[1]! : plain
    const rates: OpenCodeCost = {}
    PRICE_LEVERS.forEach((lever, i) => {
      const value = usd(cells[i]!, label)
      if (value !== undefined) rates[lever] = value
    })
    const row = rows.get(name) ?? {}
    const slot = !tier || tier[2] === '≤' ? 'base' : 'over'
    if (row[slot]) throw new Error(`opencode: duplicate price row ${label}`)
    row[slot] = rates
    if (tier) row[tier[2] === '≤' ? 'upTo' : 'from'] = Number(tier[3]) * 1000
    rows.set(name, row)
  }

  const imageTable = sectionTable(doc.text, 'Image pricing', 3)
  const imageRows = new Map<string, { price: string; notes: string }>()
  if (imageTable) {
    if (imageTable[0]!.join('|') !== IMAGE_HEADER.join('|')) {
      throw new Error('opencode: pricing page Image pricing header changed')
    }
    for (const [name, price, notes, ...rest] of imageTable.slice(2)) {
      if (
        !name ||
        price === undefined ||
        notes === undefined ||
        rest.length > 0
      ) {
        throw new Error(`opencode: unreadable image price row ${name ?? ''}`)
      }
      if (imageRows.has(name)) {
        throw new Error(`opencode: duplicate image price row ${name}`)
      }
      imageRows.set(name, { price, notes })
    }
  }

  // "Embedding models charge for input tokens only", per 1M tokens.
  const embeddingTable = sectionTable(doc.text, 'Embedding pricing', 3)
  const embeddingRows = new Map<string, number>()
  if (embeddingTable) {
    if (embeddingTable[0]!.join('|') !== EMBEDDING_HEADER.join('|')) {
      throw new Error('opencode: pricing page Embedding pricing header changed')
    }
    for (const [name, input, ...rest] of embeddingTable.slice(2)) {
      const rate = input === undefined ? undefined : usd(input, name ?? '')
      if (!name || rate === undefined || rest.length > 0) {
        throw new Error(
          `opencode: unreadable embedding price row ${name ?? ''}`,
        )
      }
      if (embeddingRows.has(name) || rows.has(name) || imageRows.has(name)) {
        throw new Error(`opencode: ${name} is priced twice`)
      }
      embeddingRows.set(name, rate)
    }
  }

  const source = {
    url: OPENCODE_PRICING_URL,
    hash: doc.hash,
    extractedAt: doc.extractedAt,
  }
  const cards = new Map<string, RateCard>()
  for (const [name, row] of rows) {
    if (imageRows.has(name)) {
      throw new Error(`opencode: ${name} is priced twice`)
    }
    const id = idByName.get(name)
    if (!id) throw new Error(`opencode: price row ${name} names no model id`)
    if (!row.base || row.upTo !== row.from) {
      throw new Error(`opencode: unreadable context tiers for ${name}`)
    }
    const tiers = row.over
      ? [{ minPromptTokens: row.from!, rates: row.over }]
      : []
    cards.set(id, compileOpenCodeCost(row.base, tiers, id, source))
  }
  for (const [name, rate] of embeddingRows) {
    const id = idByName.get(name)
    if (!id) throw new Error(`opencode: price row ${name} names no model id`)
    const card = compileTokenCard({ input_tokens: rate / 1e6 }, [], source)
    if (!card) throw new Error(`opencode: unreadable price for ${id}`)
    cards.set(id, card)
  }
  const imagePriced = new Set<string>()
  const unverified = new Set<string>()
  for (const [name, cells] of imageRows) {
    const id = idByName.get(name)
    if (!id) throw new Error(`opencode: price row ${name} names no model id`)
    const card = compileImagePrice(name, cells.price, cells.notes, source)
    if (card === 'unverified') unverified.add(name)
    else {
      imagePriced.add(name)
      cards.set(id, card)
    }
  }
  // The Endpoints table names the model set. A price table that ends early
  // (a blank line, a split table) would otherwise clear the rows after it.
  // An image model is priced in Image pricing, an embedding model in
  // Embedding pricing, not in the token table.
  // An unverified image row is an explicit absence, not a missing row.
  for (const name of idByName.keys()) {
    if (
      !rows.has(name) &&
      !embeddingRows.has(name) &&
      !imagePriced.has(name) &&
      !unverified.has(name)
    ) {
      throw new Error(`opencode: ${name} has an endpoint but no price row`)
    }
  }
  assertParsed(cards, 'opencode-pricing')
  return cards
}

export async function loadOpenCodePricing(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs = cachedDocs,
): Promise<Map<string, RateCard>> {
  const doc = await cached(kv, OPENCODE_PRICING_URL, async () => {
    const text = await fetchText(OPENCODE_PRICING_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    return {
      text,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }
  })
  return parseOpenCodePricing(doc)
}
