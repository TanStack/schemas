import { describe, expect, it } from 'vitest'

import { price, priceDetailed } from '@modelschemas/rate-card'

import type { ByteplusDoc } from './byteplus-pricing.ts'
import {
  compileSeedAudioCard,
  parseSeedAsrRate,
  parseSeedAudioCap,
  parseSeedAudioRate,
  parseSpeechRates,
} from './byteplus-speech-pricing.ts'
import asrPricing from './fixtures/byteplus-asr-pricing.json'
import audioPricing from './fixtures/byteplus-audio-pricing.json'

// The two billing pages' `curDoc.Content`, read 2026-11-17.
const audioDoc = audioPricing as unknown as ByteplusDoc
const asrDoc = asrPricing as unknown as ByteplusDoc
/** The `original_duration` line of the API page, as its op reads. */
const apiDoc: ByteplusDoc = {
  data: {
    '0': {
      ops: [
        {
          insert:
            "Duration of the model's original output audio (in seconds). This is also the duration used for billing, with a maximum of 120s.\n",
        },
      ],
    },
  },
}

const SOURCE = { url: 'https://x', hash: 'h', extractedAt: '2026-11-17' }

describe('byteplus speech pricing pages', () => {
  it('reads Seed Audio 1.0 at $0.15 per minute', () => {
    expect(parseSeedAudioRate(audioDoc)).toBe(0.0025)
  })

  it('reads each ASR mode and picks fast mode for seed-asr', () => {
    expect(parseSpeechRates(asrDoc).map((rate) => rate.label)).toEqual([
      'Streaming ASR',
      'Audio File ASR',
      'Audio File ASR Fast Mode',
    ])
    // $0.36 per hour.
    expect(parseSeedAsrRate(asrDoc)).toBe(0.0001)
  })

  it('reads the 120 second billing maximum off the API page', () => {
    expect(parseSeedAudioCap(apiDoc)).toBe(120)
  })

  it('throws rather than pricing a page it cannot read', () => {
    expect(() => parseSeedAudioRate(asrDoc)).toThrow(/3 price tables/)
    expect(() => parseSeedAsrRate(audioDoc)).toThrow(/0 "Audio File ASR Fast/)
    expect(() => parseSeedAudioCap(audioDoc)).toThrow(/maximum of Ns/)
    const perMonth = JSON.parse(
      JSON.stringify(audioDoc).replace('minute\\n', 'month\\n'),
    ) as ByteplusDoc
    expect(() => parseSeedAudioRate(perMonth)).toThrow(/unreadable/)
  })
})

describe('Seed Audio card', () => {
  const card = compileSeedAudioCard(
    0.0025,
    { seconds: 120, url: 'https://api', hash: 'c' },
    SOURCE,
  )

  it('bills the seconds the response reports', () => {
    expect(price(card, {}, { original_duration: 60 })).toBeCloseTo(0.15, 12)
  })

  it('labels the 120 second maximum as an estimate when none are given', () => {
    const held = priceDetailed(card, {}, {})
    expect(held.estimated).toEqual(['original_duration'])
    expect(held.amount).toBeCloseTo(0.3, 12)
  })
})
