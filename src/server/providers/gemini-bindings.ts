/**
 * Facts Google states outside the pricing page and the model index
 * (issue #497).
 *
 * A deprecations row that says API requests are automatically routed to
 * one id is that id's Standard card. A recommended replacement is not.
 * A changelog sentence that names a `-latest` alias binds that alias to
 * one model, newest sentence first, and does not follow a later "points
 * to". That alias is billed as the target, so it takes the target's price
 * when it has none of its own. Gemma 4 sizes come from the model card's
 * Supported Modalities cell; the card's "generating text output" sentence
 * is the output. A deprecations table's Release date column is the model's
 * release day, or the first of a month when the cell names only the month.
 */
import {
  cachedDocs,
  docsReport,
  docsRun,
  markdocTables,
  parseDay,
  tryDocs,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  DocsFailures,
  FactAbsence,
  FactSource,
  ModelFact,
  ModelFactSources,
} from './types.ts'

export const GEMINI_DEPRECATIONS_URL =
  'https://aistudio.google.com/docs/deprecations.md'

export const GEMINI_CHANGELOG_URL =
  'https://aistudio.google.com/docs/changelog.md'

/** Served as HTML only: the `.md.txt` mirror is gone (issue #568). */
export const GEMMA_MODEL_CARD_URL =
  'https://ai.google.dev/gemma/docs/core/model_card_4'

const CHANGELOG_MARK = 'This page documents updates to the Gemini API'

/** Opening sentence of the deprecations page. An error document lacks it. */
const DEPRECATIONS_MARK = 'This page lists the known deprecation schedules'

const ID = String.raw`[a-z0-9][a-z0-9.-]+`

export interface GemmaModalities {
  input: Array<string>
  output: Array<string>
}

/** `source` → the one id API requests are automatically routed to. */
export function parseAutomaticRoutes(text: string): Map<string, string> {
  const routes = new Map<string, string>()
  const targetOf =
    /automatically (?:routed to|routes api requests to) `([a-z0-9][a-z0-9.-]+)`/i
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.includes('|') ? chunk.split('\n') : [chunk]
    for (const line of lines) {
      const target = targetOf.exec(line)?.[1]
      if (!target) continue
      const ids = [...line.matchAll(new RegExp(`\`(${ID})\``, 'gi'))].map(
        (match) => match[1] ?? '',
      )
      const sources = [
        ...new Set(ids.filter((id) => id !== '' && id !== target)),
      ]
      const source = sources.length === 1 ? sources[0] : undefined
      if (!source || routes.has(source)) continue
      routes.set(source, target)
    }
  }
  return routes
}

/**
 * `October 13, 2026` → that day. `August 2026` → the first of the month,
 * the same grain as a preview id's `-MM-YYYY` suffix. Anything else is
 * not a date this page stated.
 */
function statedReleaseDay(cell: string): string | null {
  const text = cell.trim()
  const day = parseDay(text)
  if (day !== null) return new Date(day).toISOString().slice(0, 10)
  const month = /^([A-Za-z]+) (\d{4})$/.exec(text)
  if (!month?.[1] || !month[2]) return null
  const first = parseDay(`${month[1]} 1, ${month[2]}`)
  return first === null ? null : new Date(first).toISOString().slice(0, 10)
}

/**
 * Model id → `YYYY-MM-DD` from a Release date column. An id mentioned only
 * inside parentheses (a route target in the model cell) is not that row's
 * model. The first table that dates an id wins; the page does not disagree
 * with itself.
 */
export function parseGeminiReleaseDates(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  let releaseCol = -1
  for (const line of markdocTables(markdown).split('\n')) {
    if (!line.startsWith('|')) {
      releaseCol = -1
      continue
    }
    const columns = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (columns.some((cell) => /release date/i.test(cell))) {
      releaseCol = columns.findIndex((cell) => /release date/i.test(cell))
      continue
    }
    if (releaseCol < 0 || columns.every((cell) => /^:?-+:?$/.test(cell))) {
      continue
    }
    const date = statedReleaseDay(columns[releaseCol] ?? '')
    if (!date) continue
    const subject = (columns[0] ?? '').replace(/\([^)]*\)/g, '')
    for (const match of subject.matchAll(/`([a-z0-9][a-z0-9.-]+)`/g)) {
      const id = match[1]
      if (id && !out.has(id)) out.set(id, date)
    }
  }
  return out
}

/**
 * `-latest` alias → the model the changelog says it is. The file is
 * newest first; the first sentence wins. An alias with no sentence is
 * absent. "points to" is not an alias.
 */
export function parseChangelogAliases(markdown: string): Map<string, string> {
  if (!markdown.includes(CHANGELOG_MARK)) {
    throw new Error('gemini changelog: not the Gemini API changelog')
  }
  const aliases = new Map<string, string>()
  const set = (alias: string, target: string) => {
    if (!alias.includes('latest') || alias === target || aliases.has(alias)) {
      return
    }
    aliases.set(alias, target)
  }
  for (const item of markdown.split(/\n(?=\s*- )/)) {
    for (const line of item.split('\n')) {
      const switched = line.match(
        new RegExp(`\`(${ID})\` switched to \`(${ID})\``, 'i'),
      )
      if (switched?.[1] && switched[2]) set(switched[1], switched[2])
    }
    const behind = item.match(
      new RegExp(String.raw`model behind \`(${ID})\``, 'i'),
    )
    const alias = behind?.[1]
    if (!alias) continue
    const others = [
      ...new Set(
        [...item.matchAll(/`(gemini-[a-z0-9][a-z0-9.-]*)`/gi)]
          .map((match) => match[1] ?? '')
          .filter((id) => id !== '' && id !== alias),
      ),
    ]
    const target = others.length === 1 ? others[0] : undefined
    if (target) set(alias, target)
  }
  return aliases
}

const GEMMA_MEDIA: Record<string, string> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
}
const GEMMA_MEDIA_ORDER = ['text', 'image', 'audio', 'video']

function cells(line: string): Array<string> {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

/** Each HTML `<table>` as `| a | b |` lines, one per `<tr>`. */
export function htmlTables(html: string): string {
  return html.replace(
    /<table[^>]*>([\s\S]*?)<\/table>/g,
    (_table, body: string) =>
      `\n${[...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
        .map(
          ([, row = '']) =>
            `| ${[...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
              .map(([, cell = '']) =>
                cell
                  .replace(/<[^>]*>/g, '')
                  .replace(/\s+/g, ' ')
                  .trim(),
              )
              .join(' | ')} |`,
        )
        .join('\n')}\n`,
  )
}

function gemmaId(header: string): string | null {
  const clean = header.replace(/[*_`]/g, '').trim()
  const size = /(?:^|[^a-z])(\d+)\s*b/i.exec(clean)
  if (!size?.[1]) return null
  const kind = /a4b/i.test(clean) ? `${size[1]}b-a4b` : `${size[1]}b`
  return `gemma-4-${kind}-it`
}

function gemmaInputs(cell: string): Array<string> {
  const found = new Set<string>()
  const items = cell
    .replace(/[*_`]/g, '')
    .split(/,|\band\b/i)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  for (const item of items) {
    const medium = GEMMA_MEDIA[item]
    if (!medium) throw new Error(`gemma model card: unknown modality "${item}"`)
    found.add(medium)
  }
  if (found.size === 0) throw new Error('gemma model card: empty modality cell')
  return GEMMA_MEDIA_ORDER.filter((medium) => found.has(medium))
}

/**
 * Size column → input from that Supported Modalities cell, output text.
 * No such row is an empty map. A row that names no size, or a word that
 * is not a medium, throws. "E2B" is not a 2B model.
 */
export function parseGemmaModalities(
  markdown: string,
): Map<string, GemmaModalities> {
  const out = new Map<string, GemmaModalities>()
  if (!/^\|.*Supported Modalities/im.test(markdown)) return out
  if (!/generating text output/i.test(markdown)) {
    throw new Error(
      'gemma model card: Supported Modalities without a text-output sentence',
    )
  }
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i] ?? ''
    if (!/^\|\s*Property\s*\|/i.test(headerLine)) continue
    const headers = cells(headerLine)
    let modalities: Array<string> | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (!line.startsWith('|')) break
      if (/^\|\s*\**Supported Modalities\**/i.test(line)) {
        modalities = cells(line)
        break
      }
    }
    if (!modalities) continue
    let bound = 0
    for (let column = 1; column < headers.length; column++) {
      const id = gemmaId(headers[column] ?? '')
      if (!id) continue
      const cell = (modalities[column] ?? '').replace(/[*_`]/g, '').trim()
      if (cell === '' || cell === '-' || cell === '—' || /^n\/a$/i.test(cell)) {
        continue
      }
      out.set(id, { input: gemmaInputs(cell), output: ['text'] })
      bound++
    }
    if (bound === 0) {
      throw new Error(
        'gemma model card: Supported Modalities row did not bind a model',
      )
    }
  }
  if (out.size === 0) {
    throw new Error(
      'gemma model card: Supported Modalities row did not bind a model',
    )
  }
  return out
}

export interface GeminiDeprecationFacts {
  routes: Record<string, string>
  /** Model id → `YYYY-MM-DD`. Empty when a cached doc predates the column. */
  released: Record<string, string>
}

/**
 * Throws when the fetch fails or the body is not the deprecations page.
 * A real page that names no automatic route returns empty `routes`, and
 * the poll may then clear those cards. `geminiModelPricing` loads this
 * through `tryDocs`, so a throw keeps stored cards instead of failing
 * the poll.
 */
export async function geminiAutomaticRoutes(
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
): Promise<GeminiDeprecationFacts> {
  const doc = await cached(kv, GEMINI_DEPRECATIONS_URL, async () => {
    const markdown = await fetchText(GEMINI_DEPRECATIONS_URL)
    if (!markdown.includes(DEPRECATIONS_MARK)) {
      throw new Error(
        'gemini deprecations: not the Gemini API deprecations page',
      )
    }
    return {
      routes: Object.fromEntries(parseAutomaticRoutes(markdown)),
      released: Object.fromEntries(parseGeminiReleaseDates(markdown)),
      hash: await sha256Text(markdown),
    }
  })
  // A hit cached before the Release date column was stored has no
  // `released`. The next refresh fills it; until then dates stay empty.
  return { routes: doc.routes, released: cachedReleaseDates(doc) }
}

function cachedReleaseDates(doc: {
  released?: Record<string, string>
}): Record<string, string> {
  return doc.released ?? {}
}

export interface GeminiPublishedBindings {
  /** Null when the changelog could not be read. `{}` means it names none. */
  aliases: Record<string, string> | null
  changelog: { url: string; hash: string }
  /** Null when the model card could not be read. */
  gemma: Record<string, GemmaModalities> | null
  gemmaSource: { url: string; hash: string }
  docsFailures: DocsFailures
}

export async function geminiPublishedBindings(
  kv?: KVNamespace,
): Promise<GeminiPublishedBindings> {
  const run = docsRun()
  const [changelog, gemma] = await Promise.all([
    tryDocs(run, GEMINI_CHANGELOG_URL, (cached) =>
      cached(kv, GEMINI_CHANGELOG_URL, async () => {
        const markdown = await fetchText(GEMINI_CHANGELOG_URL)
        return {
          aliases: Object.fromEntries(parseChangelogAliases(markdown)),
          hash: await sha256Text(markdown),
        }
      }),
    ),
    tryDocs(run, GEMMA_MODEL_CARD_URL, (cached) =>
      cached(kv, GEMMA_MODEL_CARD_URL, async () => {
        const markdown = await fetchText(GEMMA_MODEL_CARD_URL)
        if (!markdown.includes('Gemma 4')) {
          throw new Error('gemma model card: not the Gemma 4 card')
        }
        return {
          modalities: Object.fromEntries(
            parseGemmaModalities(htmlTables(markdown)),
          ),
          hash: await sha256Text(markdown),
        }
      }),
    ),
  ])
  return {
    aliases: changelog ? changelog.aliases : null,
    changelog: {
      url: GEMINI_CHANGELOG_URL,
      hash: changelog?.hash ?? '',
    },
    gemma: gemma ? gemma.modalities : null,
    gemmaSource: { url: GEMMA_MODEL_CARD_URL, hash: gemma?.hash ?? '' },
    docsFailures: docsReport(run),
  }
}

interface FactRow {
  rawId: string
  modalities?: unknown
  aliases?: Array<string> | null
  aliasOf?: string | null
  pricing?: unknown
  serverTools?: Array<string> | null
  factSources?: ModelFactSources
  absent?: Partial<Record<ModelFact, FactAbsence>>
}

function sourceHash(hash: string | undefined): { sourceHash?: string } {
  return hash ? { sourceHash: hash } : {}
}

/**
 * Copy a published Gemma cell, then a changelog alias's modalities and
 * server tools, onto rows that still have none. A failed document keeps stored modalities
 * (`unavailable`) instead of clearing them.
 */
export function attachGeminiPublishedFacts<T extends FactRow>(
  models: Array<T>,
  bindings: GeminiPublishedBindings,
): Array<T> {
  const byId = new Map(models.map((model) => [model.rawId, { ...model }]))
  const put = (model: T) => {
    byId.set(model.rawId, model)
  }

  const rawIds = Array.from(byId.keys())
  if (bindings.gemma) {
    for (const rawId of rawIds) {
      const model = byId.get(rawId)
      const modalities = model ? bindings.gemma[rawId] : undefined
      if (!model || model.modalities != null || !modalities) continue
      put({
        ...model,
        modalities,
        factSources: {
          ...model.factSources,
          modalities: {
            derivation: 'docs-derived',
            sourceUrl: bindings.gemmaSource.url,
            ...sourceHash(bindings.gemmaSource.hash),
            path: 'Supported Modalities',
          },
        },
      })
    }
  }

  if (bindings.aliases) {
    const changelogSource = (path: string) => ({
      derivation: 'docs-derived' as const,
      sourceUrl: bindings.changelog.url,
      ...sourceHash(bindings.changelog.hash),
      path,
    })
    // A `-latest` row the changelog names no target for (issue #709). The
    // link itself comes only from a changelog sentence, never the id.
    for (const rawId of rawIds) {
      const model = byId.get(rawId)
      if (!model || !rawId.includes('latest') || rawId in bindings.aliases) {
        continue
      }
      put({
        ...model,
        aliasOf: null,
        factSources: {
          ...model.factSources,
          aliasOf: changelogSource('unstated'),
        },
      })
    }
    for (const [alias, targetId] of Object.entries(bindings.aliases)) {
      const stated = byId.get(alias)
      // The stated target is kept even while it is not listed; the catalog
      // serves the link only while that row is live.
      if (stated) {
        put({
          ...stated,
          aliasOf: targetId,
          factSources: {
            ...stated.factSources,
            aliasOf: changelogSource('latest alias'),
          },
        })
      }
      const aliasRow = byId.get(alias)
      const target = byId.get(targetId)
      if (!aliasRow || !target) continue
      if (aliasRow.modalities == null && target.modalities != null) {
        const prior = target.factSources?.modalities
        put({
          ...aliasRow,
          modalities: target.modalities,
          factSources: {
            ...aliasRow.factSources,
            modalities: {
              derivation: 'docs-derived',
              sourceUrl: prior?.sourceUrl ?? bindings.changelog.url,
              ...sourceHash(prior?.sourceHash ?? bindings.changelog.hash),
              path: `Supported data types; alias of ${targetId}`,
            },
          },
        })
      }
      // The alias is the target model, so the target page's tools are its
      // own (#707). A silent target stays the alias's silence, and an
      // unread one leaves the alias unread.
      const aliasTools = byId.get(alias)
      if (aliasTools && aliasTools.serverTools == null) {
        const prior = target.factSources?.serverTools
        const tools = target.serverTools ?? null
        const sources =
          tools && tools.length > 0 && prior
            ? Object.fromEntries(
                Object.entries(prior as Record<string, FactSource>).map(
                  ([tool, source]) => [
                    tool,
                    { ...source, path: `${source.path}; alias of ${targetId}` },
                  ],
                ),
              )
            : prior?.derivation === 'source-silent'
              ? prior
              : undefined
        if (sources) {
          put({
            ...aliasTools,
            ...(tools && tools.length > 0 ? { serverTools: tools } : {}),
            factSources: { ...aliasTools.factSources, serverTools: sources },
          })
        } else if (target.absent?.serverTools === 'unavailable') {
          // The target's page failed: the alias keeps its stored tools too.
          put({
            ...aliasTools,
            absent: { ...aliasTools.absent, serverTools: 'unavailable' },
          })
        }
      }
      const current = byId.get(targetId)
      if (!current) continue
      put({
        ...current,
        aliases: [...new Set([...(current.aliases ?? []), alias])].sort(),
        factSources: {
          ...current.factSources,
          aliases: changelogSource('latest alias'),
        },
      })
      const priced = byId.get(targetId)
      const aliasNow = byId.get(alias)
      if (
        !aliasNow ||
        !priced ||
        aliasNow.pricing != null ||
        priced.pricing == null
      ) {
        continue
      }
      const prior = priced.factSources?.pricing
      const absent = { ...aliasNow.absent }
      delete absent.pricing
      const next: T = {
        ...aliasNow,
        pricing: priced.pricing,
        factSources: {
          ...aliasNow.factSources,
          pricing: {
            derivation: 'docs-derived',
            sourceUrl: prior?.sourceUrl ?? bindings.changelog.url,
            ...sourceHash(
              prior?.sourceUrl ? prior.sourceHash : bindings.changelog.hash,
            ),
            path: prior?.path
              ? `${prior.path}; alias of ${targetId}`
              : `alias of ${targetId}`,
          },
        },
      }
      if (Object.keys(absent).length > 0) next.absent = absent
      else delete next.absent
      put(next)
    }
  } else {
    for (const rawId of rawIds) {
      const model = byId.get(rawId)
      if (!model) continue
      // Every alias link comes from the changelog: keep the stored ones.
      const absent: Partial<Record<ModelFact, FactAbsence>> = {
        ...model.absent,
        aliases: 'unavailable',
      }
      if (rawId.includes('latest')) {
        absent.aliasOf = 'unavailable'
        if (model.modalities == null) absent.modalities = 'unavailable'
        if (model.serverTools == null) absent.serverTools = 'unavailable'
      }
      put({ ...model, absent })
    }
  }

  if (!bindings.gemma) {
    for (const rawId of rawIds) {
      const model = byId.get(rawId)
      if (!model || !rawId.startsWith('gemma-4-') || model.modalities != null) {
        continue
      }
      put({
        ...model,
        absent: { ...model.absent, modalities: 'unavailable' },
      })
    }
  }

  return models.map((model) => byId.get(model.rawId) ?? model)
}
