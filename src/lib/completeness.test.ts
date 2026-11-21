import { describe, expect, it } from 'vitest'

import {
  buildReport,
  parseLedger,
  rowCompleteness,
  scoreRow,
} from './completeness.ts'
import type { ModelRow } from './completeness.ts'

const chat: ModelRow = {
  provider: 'host',
  rawId: 'm',
  activity: 'chat',
  contextWindow: 8,
  maxOutput: 8,
  modalities: { input: ['text'] },
  pricing: {
    tables: {
      rate: {
        base: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0.1 },
      },
    },
  },
  capabilities: { reasoning: true },
  reasoning: { mode: 'effort', mandatory: true, efforts: ['low'] },
  requestMap: { replayReasoningContent: false },
  schemaEndpointId: 'chat/completions',
}

describe('applicable facts', () => {
  it('scores replayReasoningContent only on chat/completions routes', () => {
    const report = buildReport([
      chat,
      {
        ...chat,
        rawId: 'messages',
        schemaEndpointId: 'v1/messages',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'converse',
        schemaEndpointId: 'model/x/converse',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'responses',
        schemaEndpointId: 'responses',
        requestMap: null,
      },
      {
        ...chat,
        rawId: 'gemini',
        schemaEndpointId: 'v1beta/models/{modelsId}:generateContent',
        requestMap: { maxTokensField: 'max_tokens' },
      },
    ])
    const host = report.providers[0]
    expect(host?.activities.chat?.facts?.replayReasoningContent).toEqual({
      have: 1,
      need: 1,
    })
    expect(host?.activities.chat?.facts?.requestMap).toEqual({
      have: 1,
      need: 2,
    })
  })

  it('does not score requestMap on a native route', () => {
    const report = buildReport([
      {
        ...chat,
        schemaEndpointId: 'v1/messages',
        requestMap: null,
        reasoning: null,
        capabilities: { tools: true },
      },
    ])
    expect(report.providers[0]?.activities.chat?.facts?.requestMap).toEqual({
      have: 0,
      need: 0,
    })
    expect(
      report.providers[0]?.activities.chat?.facts?.replayReasoningContent,
    ).toEqual({
      have: 0,
      need: 0,
    })
  })

  it('counts a stated cache absence and not a made-up price', () => {
    const report = buildReport([
      {
        ...chat,
        pricing: {
          tables: { rate: { base: { input_tokens: 1, output_tokens: 2 } } },
        },
        factSources: { cacheRead: { path: 'not-offered' } },
      },
    ])
    expect(report.providers[0]?.activities.chat?.facts?.cacheRead).toEqual({
      have: 1,
      need: 1,
    })
  })

  it('leaves a native replay row out of a model-scoped ledger denominator', () => {
    const report = buildReport(
      [{ ...chat, schemaEndpointId: 'v1/messages', requestMap: null }],
      parseLedger('- host/m: replayReasoningContent — native route'),
    )
    const host = report.providers[0]?.activities.chat
    expect(host?.facts?.replayReasoningContent?.need).toBe(0)
    expect(host?.modelSilent.replayReasoningContent).toBeUndefined()
  })
})

describe('activities other than chat', () => {
  const speech: ModelRow = {
    provider: 'speech',
    rawId: 'tts',
    activity: 'audio',
    modalities: { input: ['text'], output: ['audio'] },
    pricing: { tables: {} },
    schemaEndpointId: 'v1/text-to-speech',
  }

  it('scores an audio-only provider on its media facts', () => {
    const report = buildReport([
      speech,
      { ...speech, rawId: 'bare', modalities: null, pricing: null },
    ])
    const audio = report.providers[0]?.activities.audio
    expect(audio?.facts).toEqual({
      priced: { have: 1, need: 2 },
      endpoint: { have: 2, need: 2 },
      modalities: { have: 1, need: 2 },
      outputModalities: { have: 1, need: 2 },
    })
    expect(audio?.score).toBe(5 / 8)
    expect(report.providers[0]?.score).toBe(5 / 8)
  })

  it('does not count a models.dev card as a media price', () => {
    const report = buildReport([
      {
        ...speech,
        pricing: { tables: {}, source: { url: 'https://models.dev/x' } },
      },
    ])
    expect(report.providers[0]?.activities.audio?.facts?.priced).toEqual({
      have: 0,
      need: 1,
    })
  })

  it('counts an unclassified row as a gap on every provider', () => {
    const report = buildReport([speech, { provider: 'speech', activity: null }])
    const p = report.providers[0]
    expect(p?.noActivity).toBe(1)
    expect(p?.activities.unclassified?.facts).toEqual({
      activity: { have: 0, need: 1 },
    })
    expect(p?.score).toBe(4 / 5)
    const only = buildReport([{ provider: 'x', activity: null }])
    expect(only.providers[0]?.score).toBe(0)
  })

  it('lists an activity with no fact set without scoring it', () => {
    const report = buildReport([
      { provider: 'embed', rawId: 'e', activity: 'embeddings' },
    ])
    const p = report.providers[0]
    expect(p?.activities.embeddings).toMatchObject({
      rows: 1,
      facts: null,
      score: null,
    })
    expect(p?.score).toBeNull()
  })
})

describe('origin links', () => {
  const origin: ModelRow = { provider: 'maker', rawId: 'model-4-5' }
  const linked: ModelRow = {
    provider: 'gateway',
    rawId: 'model-4.5',
    sameAs: { provider: 'maker', rawId: 'model-4-5' },
  }

  // The link rules' cases are pinned against reconcileSameAs in
  // src/server/ingest/origin-link-score.worker.test.ts.
  it('needs a link only where the service wrote one', () => {
    const report = buildReport([
      origin,
      linked,
      // The same name, unlinked: the rules found no single maker root.
      { provider: 'host', rawId: 'model-4.5' },
    ])
    const by = (id: string) =>
      report.providers.find((p) => p.provider === id)?.originLink
    expect(by('maker')).toEqual({ have: 0, need: 0, modelSilent: 0 })
    expect(by('gateway')).toEqual({ have: 1, need: 1, modelSilent: 0 })
    expect(by('host')).toEqual({ have: 0, need: 0, modelSilent: 0 })
  })

  it('names the missing facts of one row', () => {
    const row: ModelRow = { ...chat, maxOutput: null }
    expect(
      rowCompleteness(scoreRow(row, parseLedger('- host: cacheRead — none'))),
    ).toEqual({ filled: 9, needed: 10, missing: ['maxOutput'] })
    // A linked row needs its link and has it.
    expect(
      rowCompleteness(scoreRow({ ...row, sameAs: linked.sameAs })),
    ).toEqual({ filled: 11, needed: 12, missing: ['maxOutput'] })
  })
})
