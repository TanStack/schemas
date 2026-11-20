import { describe, expect, it } from 'vitest'

import {
  goListingRoutes,
  goTrainsOnRequestData,
  openCodeGoFacts,
} from './opencode-go-facts.ts'

describe('openCodeGoFacts', () => {
  it('requires the session header and User-Agent on every Go row', () => {
    const facts = openCodeGoFacts('opencode-go', 'glm-5.2')
    expect(facts.requiredRequestHeaders?.map((header) => header.name)).toEqual([
      'x-opencode-session',
      'User-Agent',
    ])
    expect(facts.trainsOnRequestData).toBeNull()
    expect(facts.factSources.requiredRequestHeaders).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: 'https://opencode.ai/docs/console/go/',
    })
    expect(facts.factSources.trainsOnRequestData).toBeUndefined()
  })

  it('sets training only on the id whose probe stated it', () => {
    const argon = openCodeGoFacts('opencode-go', 'gemini-4-argon-contributor')
    expect(argon.trainsOnRequestData).toBe(true)
    expect(argon.factSources.trainsOnRequestData).toMatchObject({
      derivation: 'probe-verified',
      verifiedAt: '2026-10-23',
    })
    expect(
      openCodeGoFacts('opencode-go', 'muse-spark-1.3-contributor')
        .trainsOnRequestData,
    ).toBeNull()
    expect(openCodeGoFacts('opencode', 'gemini-4-argon-contributor')).toEqual({
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    })
  })
})

describe('goTrainsOnRequestData', () => {
  it('reads the listing boolean and does not treat false as missing', () => {
    const training = goTrainsOnRequestData({
      object: 'list',
      data: [
        { id: 'muse-spark-1.3-contributor', go: { training: true } },
        { id: 'grok-4.7', go: { training: false } },
      ],
    })
    expect(training.get('muse-spark-1.3-contributor')).toBe(true)
    expect(training.get('grok-4.7')).toBe(false)
  })

  it('throws when go.training is missing or not a boolean', () => {
    expect(() =>
      goTrainsOnRequestData({
        object: 'list',
        data: [{ id: 'grok-4.7', go: { training: '30 days' } }],
      }),
    ).toThrow(/grok-4\.7/)
  })
})

describe('goListingRoutes', () => {
  it('reads routes from api.protocol.base_url and ignores other listing facts', () => {
    const routes = goListingRoutes({
      object: 'list',
      data: [
        {
          id: 'deepseek-v4.1-flash',
          cost: { input: 0.3, output: 1.2 },
          limit: { context: 128000, output: 8192 },
          capabilities: { tools: true },
          api: {
            'chat-completions': {
              base_url: 'https://opencode.ai/inference/go/openai/v1',
              sdk: {
                aisdk: '@ai-sdk/openai-compatible',
                opencodeai: '@opencode/ai/providers/openai-compatible',
              },
            },
          },
        },
        {
          id: 'grok-4.7',
          api: {
            responses: {
              base_url: 'https://opencode.ai/inference/go/openai/v1/',
              sdk: { aisdk: '@ai-sdk/openai' },
            },
          },
        },
        {
          id: 'gemini-4-argon',
          api: {
            'generate-content': {
              base_url: 'https://opencode.ai/inference/go/google/v1beta',
              sdk: { aisdk: '@ai-sdk/google' },
              capabilities: { tools: { choice: ['auto'] } },
            },
          },
        },
      ],
    })
    expect(routes).toEqual([
      '/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
      '/inference/go/openai/v1/chat/completions',
      '/inference/go/openai/v1/responses',
    ])
  })

  it('reads the live gemini-4-argon interactions route with the model out of the path', () => {
    // gemini-4-argon is GET https://opencode.ai/inference/go/v1/models on
    // 2026-11-20. The contributor row is only here to show a shared base
    // collapses to one interactions path.
    const routes = goListingRoutes({
      object: 'list',
      data: [
        {
          id: 'gemini-4-argon',
          api: {
            'generate-content': {
              base_url: 'https://opencode.ai/inference/go/google/v1beta',
              sdk: {
                aisdk: '@ai-sdk/google',
                opencodeai: '@opencode/ai/providers/google',
              },
              capabilities: {
                tools: { choice: ['auto', 'none', 'required', 'tool'] },
              },
            },
            interactions: {
              base_url: 'https://opencode.ai/inference/go/google/v1beta/',
              sdk: {
                aisdk: '@ai-sdk/google',
                opencodeai: '@opencode/ai/providers/google/interactions',
              },
            },
          },
          cost: { input: 1, output: 2 },
          limit: { context: 1000000 },
        },
        {
          id: 'gemini-4-argon-contributor',
          api: {
            interactions: {
              base_url: 'https://opencode.ai/inference/go/google/v1beta',
              sdk: {
                opencodeai: '@opencode/ai/providers/google/interactions',
              },
            },
          },
        },
      ],
    })
    expect(routes).toEqual([
      '/inference/go/google/v1beta/interactions',
      '/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
    ])
  })

  it('throws when api is missing or the protocol key is unknown', () => {
    expect(() =>
      goListingRoutes({
        object: 'list',
        data: [{ id: 'grok-4.7', go: { training: false } }],
      }),
    ).toThrow('opencode-go: grok-4.7 has no api entry')
    expect(() =>
      goListingRoutes({
        object: 'list',
        data: [
          {
            id: 'grok-4.7',
            api: {
              embeddings: {
                base_url: 'https://opencode.ai/inference/go/openai/v1',
              },
            },
          },
        ],
      }),
    ).toThrow('opencode-go: grok-4.7 has unknown api protocol embeddings')
  })
})
