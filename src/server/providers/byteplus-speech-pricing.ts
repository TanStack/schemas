/**
 * Seed Speech rate cards (#672). BytePlus prices the voice product on its
 * own billing pages, not the ModelArk pricing page:
 *
 * - Seed Audio 1.0: pay-as-you-go USD per minute of generated audio,
 *   metered by the second. The API page states the billed quantity: the
 *   response's `original_duration` (seconds before `speech_rate`), "with a
 *   maximum of 120s". That number exists only in the response, so the card
 *   carries the published maximum as its estimate: an upper bound a caller
 *   can hold before the request runs. BytePlus publishes no way to get
 *   seconds from `text_prompt`, so none is made up here.
 * - Seed ASR: the catalog row is the flash endpoint
 *   (`volc.seedasr.auc_turbo`), which the billing page prices as "Audio
 *   File ASR Fast Mode", USD per hour of audio.
 *
 * Pre-paid packages are not a per-request price and are ignored. Each page
 * is loaded through `tryDocs`: one that fails or stops parsing keeps the
 * stored card and is reported in `docsFailures`.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { fetchByteplusDoc } from './byteplus-docs.ts'
import { pricingContent, tableRows } from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'
import { tagDocsFacts } from './fact-sources.ts'
import { tryDocs, unavailable } from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

const VOICE_DOCS = 'https://docs.byteplus.com/en/docs/byteplusvoice'
export const BYTEPLUS_AUDIO_PRICING_URL = `${VOICE_DOCS}/audiopricing`
export const BYTEPLUS_AUDIO_API_URL = `${VOICE_DOCS}/seedaudio-01`
export const BYTEPLUS_ASR_PRICING_URL = `${VOICE_DOCS}/asrbilling`

const SECONDS_PER_UNIT: Array<[RegExp, number]> = [
  [/\bminute$/i, 60],
  [/\bhour$/i, 3600],
]

interface SpeechRate {
  /** The text line above the table ("Audio File ASR Fast Mode"). */
  label: string
  usdPerSecond: number
}

/**
 * The pay-as-you-go row of every `Payment | Fee (USD) | Unit` table on a
 * voice billing page. A table with those columns whose pay-as-you-go row
 * cannot be read throws; a table without them is not a price table.
 */
export function parseSpeechRates(doc: ByteplusDoc): Array<SpeechRate> {
  const out: Array<SpeechRate> = []
  let text = ''
  for (const op of doc.data['0']?.ops ?? []) {
    const spec = op.attributes?.aceTable
    if (!spec) {
      if (typeof op.insert === 'string') text += op.insert
      continue
    }
    const label =
      text
        .split('\n')
        .map((line) => line.replace(/^\*+/, '').trim())
        .filter((line) => line !== '')
        .at(-1)
        ?.replace(/:$/, '') ?? ''
    text = ''
    const rows = tableRows(doc, spec)
    const header = rows?.[0]?.map((cell) => cell.toLowerCase()) ?? []
    const payment = header.indexOf('payment')
    const fee = header.indexOf('fee (usd)')
    const unit = header.indexOf('unit')
    if (!rows || payment < 0 || fee < 0 || unit < 0) continue
    const row = rows.find((cells) =>
      /^pay-as-you-go$/i.test(cells[payment] ?? ''),
    )
    const usd = /^\d+(?:\.\d+)?$/.test(row?.[fee] ?? '')
      ? Number(row?.[fee])
      : 0
    const seconds = SECONDS_PER_UNIT.find(([pattern]) =>
      pattern.test(row?.[unit] ?? ''),
    )?.[1]
    if (!row || usd <= 0 || !seconds) {
      throw new Error(
        `byteplus speech pricing: unreadable pay-as-you-go row under "${label}": ${JSON.stringify(row ?? null)}`,
      )
    }
    // 0.15 / 60 is 0.0025000000000000005: drop the float noise.
    out.push({ label, usdPerSecond: Number((usd / seconds).toPrecision(12)) })
  }
  return out
}

/** Seed Audio 1.0 USD per second: the page's only price table. */
export function parseSeedAudioRate(doc: ByteplusDoc): number {
  const rates = parseSpeechRates(doc)
  const [only] = rates
  if (!only || rates.length !== 1) {
    throw new Error(
      `byteplus audio pricing: ${String(rates.length)} price tables, expected 1`,
    )
  }
  return only.usdPerSecond
}

/** Seed ASR flash USD per second: the "Audio File ASR Fast Mode" table. */
export function parseSeedAsrRate(doc: ByteplusDoc): number {
  const fast = parseSpeechRates(doc).filter(
    (rate) => rate.label.toLowerCase() === 'audio file asr fast mode',
  )
  const [only] = fast
  if (!only || fast.length !== 1) {
    throw new Error(
      `byteplus asr pricing: ${String(fast.length)} "Audio File ASR Fast Mode" tables, expected 1`,
    )
  }
  return only.usdPerSecond
}

/** The billed-seconds maximum the Seed Audio API page states for `original_duration`. */
export function parseSeedAudioCap(doc: ByteplusDoc): number {
  const text = Object.values(doc.data)
    .flatMap((zone) => zone.ops ?? [])
    .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
    .join('')
  const cap = /duration used for billing, with a maximum of (\d+)\s*s\b/.exec(
    text,
  )?.[1]
  if (!cap) {
    throw new Error(
      'byteplus audio api page: no "duration used for billing, with a maximum of Ns"',
    )
  }
  return Number(cap)
}

interface CachedNumber {
  value: number
  hash: string
  extractedAt: string
}

/** One number read off one voice docs page, or null (counted in `run`). */
function pageNumber(
  run: DocsRun,
  kv: KVNamespace | undefined,
  url: string,
  read: (doc: ByteplusDoc) => number,
): Promise<CachedNumber | null> {
  return tryDocs(run, url, (cached) =>
    cached<CachedNumber>(kv, url, async () => {
      const content = pricingContent(
        await fetchByteplusDoc(url),
        `byteplus speech page ${url}`,
      )
      return {
        value: read(JSON.parse(content) as ByteplusDoc),
        hash: await sha256Text(content),
        extractedAt: new Date().toISOString(),
      }
    }),
  )
}

/** Billed on `original_duration`; omitted, it is estimated at the published maximum. */
export function compileSeedAudioCard(
  usdPerSecond: number,
  cap: { seconds: number; url: string; hash: string },
  source: RateCard['source'],
): RateCard {
  return {
    inputs: {
      original_duration: {
        param: 'original_duration',
        bound: 'usage',
        kind: 'number',
        estimate: {
          inputs: {},
          value: cap.seconds,
          source: { url: cap.url, hash: cap.hash },
        },
      },
    },
    tables: {},
    price: { '*': [{ var: 'original_duration' }, usdPerSecond] },
    examples: [],
    source,
  }
}

type SpeechFacts = Pick<
  ModelInfo,
  'pricing' | 'factSources' | 'serverTools' | 'absent'
>

/** Card lookup for the Seed Speech rows; null for every other id. */
export async function byteplusSpeechPricing(
  run: DocsRun,
  kv?: KVNamespace,
): Promise<(rawId: string) => SpeechFacts | null> {
  const [audio, cap, asr] = await Promise.all([
    pageNumber(run, kv, BYTEPLUS_AUDIO_PRICING_URL, parseSeedAudioRate),
    pageNumber(run, kv, BYTEPLUS_AUDIO_API_URL, parseSeedAudioCap),
    pageNumber(run, kv, BYTEPLUS_ASR_PRICING_URL, parseSeedAsrRate),
  ])
  const facts = (
    page: CachedNumber | null,
    url: string,
    pricing: RateCard | null,
  ): SpeechFacts =>
    page && pricing
      ? { pricing, factSources: tagDocsFacts({ pricing }, url, page.hash) }
      : unavailable('pricing')
  const source = (page: CachedNumber, url: string): RateCard['source'] => ({
    url,
    hash: page.hash,
    extractedAt: page.extractedAt,
  })
  const cards: Record<string, SpeechFacts> = {
    'seed-audio-1.0': facts(
      audio,
      BYTEPLUS_AUDIO_PRICING_URL,
      audio && cap
        ? compileSeedAudioCard(
            audio.value,
            { seconds: cap.value, url: BYTEPLUS_AUDIO_API_URL, hash: cap.hash },
            source(audio, BYTEPLUS_AUDIO_PRICING_URL),
          )
        : null,
    ),
    'seed-asr': facts(
      asr,
      BYTEPLUS_ASR_PRICING_URL,
      asr &&
        compileUnitCard(
          {
            quantity: { param: 'audio_seconds', bound: 'usage' },
            rates: asr.value,
          },
          source(asr, BYTEPLUS_ASR_PRICING_URL),
        ),
    ),
  }
  return (rawId) => cards[rawId] ?? null
}
