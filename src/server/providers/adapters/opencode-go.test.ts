import { OPENCODE_CATALOG_URL } from '../opencode-catalog.ts'

import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_GO_MODELS_URL, provider } from './opencode-go.ts'

const OPENAI = 'https://opencode.ai/inference/go/openai/v1'
const ANTHROPIC = 'https://opencode.ai/inference/go/anthropic/v1'
const GOOGLE = 'https://opencode.ai/inference/go/google/v1beta'

function listingRow(id: string, protocol: string, base: string, sdk: string) {
  return {
    id,
    object: 'model',
    owned_by: 'opencode',
    go: { training: id === 'mini' },
    api: {
      [protocol]: {
        base_url: base,
        sdk: { aisdk: sdk },
      },
    },
  }
}

const LISTING = {
  object: 'list',
  data: [
    listingRow('mini', 'messages', ANTHROPIC, '@ai-sdk/anthropic'),
    listingRow('kimi', 'chat-completions', OPENAI, '@ai-sdk/openai-compatible'),
    listingRow('gpt', 'responses', OPENAI, '@ai-sdk/openai'),
    listingRow(
      'deepseek',
      'chat-completions',
      OPENAI,
      '@ai-sdk/openai-compatible',
    ),
    listingRow(
      'absent',
      'chat-completions',
      OPENAI,
      '@ai-sdk/openai-compatible',
    ),
  ],
}

const CATALOG = {
  'opencode-go': {
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/inference/go/openai/v1',
    models: {
      mini: {
        id: 'mini',
        name: 'Mini',
        provider: {
          npm: '@ai-sdk/anthropic',
          api: 'https://opencode.ai/inference/go/anthropic/v1',
        },
        cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
      },
      kimi: { id: 'kimi', name: 'Kimi', cost: { input: 3, output: 15 } },
      gpt: {
        id: 'gpt',
        name: 'GPT',
        provider: { npm: '@ai-sdk/openai' },
        cost: { input: 0.1, output: 0.5 },
      },
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        cost: { input: 1, output: 2 },
      },
    },
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch() {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === OPENCODE_GO_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify(LISTING)))
    }
    if (String(url) === OPENCODE_CATALOG_URL) {
      return Promise.resolve(new Response(JSON.stringify(CATALOG)))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

describe('opencode-go', () => {
  it('classifies rows by package and leaves prices null', async () => {
    const urls = stubFetch()
    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    const byId = Object.fromEntries(
      listed.models.map((model) => [model.rawId, model]),
    )
    expect(listed.models.map((model) => model.rawId)).toEqual([
      'mini',
      'kimi',
      'gpt',
      'deepseek',
      'absent',
    ])
    expect(byId.mini).toMatchObject({
      displayName: 'Mini',
      activity: 'chat',
      pricing: null,
      trainsOnRequestData: true,
      schemaEndpointId: 'inference/go/anthropic/v1/messages',
    })
    expect(byId.mini?.factSources?.trainsOnRequestData).toMatchObject({
      derivation: 'listing',
      sourceUrl: OPENCODE_GO_MODELS_URL,
      path: 'go.training',
    })
    expect(byId.kimi?.absent?.trainsOnRequestData).toBeUndefined()
    expect(byId.kimi?.trainsOnRequestData).toBeNull()
    expect(byId.gpt?.trainsOnRequestData).toBeNull()
    expect(byId.mini?.factSources?.schemaEndpointId).toMatchObject({
      derivation: 'listing',
      sourceUrl: OPENCODE_CATALOG_URL,
      path: 'opencode-go.models.mini.provider',
    })
    expect(byId.kimi).toMatchObject({
      schemaEndpointId: 'inference/go/openai/v1/chat/completions',
      pricing: null,
    })
    expect(byId.kimi?.factSources?.schemaEndpointId?.path).toBe(
      'opencode-go.npm',
    )
    expect(byId.gpt).toMatchObject({
      schemaEndpointId: 'inference/go/openai/v1/responses',
      pricing: null,
    })
    expect(byId.deepseek).toMatchObject({
      schemaEndpointId: 'inference/go/openai/v1/chat/completions',
      pricing: null,
    })
    expect(byId.absent).toEqual({
      rawId: 'absent',
      releasedAt: null,
      pricing: null,
      trainsOnRequestData: null,
      absent: { releasedAt: 'cleared' },
    })
    expect(
      provider.connect?.requiredHeaders?.map((header) => header.name),
    ).toEqual(['x-opencode-session', 'User-Agent'])
    expect(provider.modelsEndpoint).toBe(OPENCODE_GO_MODELS_URL)
    expect(
      spec.specs[0]?.paths?.['/inference/go/anthropic/v1/messages']?.post,
    ).toMatchObject({
      'x-modelschemas-route-only': true,
    })
    expect(
      spec.specs[0]?.paths?.[
        '/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent'
      ]?.post,
    ).toMatchObject({
      'x-modelschemas-route-only': true,
      'x-modelschemas-provenance': {
        derivation: 'probe-verified',
        verifiedAt: '2026-10-23',
      },
    })
    expect(spec.specs[0]?.paths?.['/v1/messages']).toBeUndefined()
    expect(urls.filter((url) => url.includes('/docs/'))).toEqual([])
    expect(urls).toContain(OPENCODE_GO_MODELS_URL)
    expect(urls).toContain(OPENCODE_CATALOG_URL)
  })

  it('binds a Go Gemini row only when that exact id has a probe record', async () => {
    const catalog = {
      'opencode-go': {
        ...CATALOG['opencode-go'],
        models: {
          ...CATALOG['opencode-go'].models,
          gemini: {
            id: 'gemini',
            name: 'Gemini',
            provider: {
              npm: '@ai-sdk/google',
              api: 'https://opencode.ai/inference/go/google/v1beta',
            },
          },
          'gemini-4-argon-contributor': {
            id: 'gemini-4-argon-contributor',
            name: 'Argon',
            provider: {
              npm: '@ai-sdk/google',
              api: 'https://opencode.ai/inference/go/google/v1beta',
            },
          },
        },
      },
    }
    globalThis.fetch = ((url: string) => {
      if (String(url) === OPENCODE_GO_MODELS_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                ...LISTING.data,
                listingRow(
                  'gemini',
                  'generate-content',
                  GOOGLE,
                  '@ai-sdk/google',
                ),
                listingRow(
                  'gemini-4-argon-contributor',
                  'generate-content',
                  GOOGLE,
                  '@ai-sdk/google',
                ),
              ],
            }),
          ),
        )
      }
      if (String(url) === OPENCODE_CATALOG_URL) {
        return Promise.resolve(new Response(JSON.stringify(catalog)))
      }
      return Promise.resolve(new Response('404: Not Found', { status: 404 }))
    }) as typeof fetch

    const spec = await provider.fetchSpec({})
    expect(Object.keys(spec.specs[0]?.paths ?? {}).sort()).toEqual([
      '/inference/go/anthropic/v1/messages',
      '/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent',
      '/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent',
      '/inference/go/openai/v1/chat/completions',
      '/inference/go/openai/v1/responses',
    ])
    const listed = await provider.listModels({})
    const gemini = listed.models.find((model) => model.rawId === 'gemini')
    const argon = listed.models.find(
      (model) => model.rawId === 'gemini-4-argon-contributor',
    )
    expect(gemini).toMatchObject({ rawId: 'gemini', activity: 'chat' })
    expect(gemini?.schemaEndpointId).toBeUndefined()
    expect(gemini?.factSources?.schemaEndpointId).toBeUndefined()
    expect(argon?.schemaEndpointId).toBe(
      'inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent',
    )
    expect(argon?.factSources?.schemaEndpointId).toEqual({
      derivation: 'probe-verified',
      verifiedAt: '2026-10-23',
      sourceUrl:
        'src/server/providers/probes/opencode-go.ts#gemini-4-argon-contributor-generate',
    })
    expect(
      spec.specs[0]?.paths?.[
        '/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent'
      ]?.post,
    ).not.toHaveProperty('requestBody')
  })

  it('throws when the catalog classifies no listed row', async () => {
    stubFetch()
    const fetchCatalog = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url) !== OPENCODE_CATALOG_URL) return fetchCatalog(url, init)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            'opencode-go': {
              npm: '@ai-sdk/openai-compatible',
              api: 'https://opencode.ai/inference/go/openai/v1',
              models: {
                mini: {
                  id: 'mini',
                  provider: { npm: '@ai-sdk/mistral' },
                },
              },
            },
          }),
        ),
      )
    }) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow(/classified 0/)
  })

  it('throws when a listed id has no go.training boolean', async () => {
    stubFetch()
    const fetchListing = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url) !== OPENCODE_GO_MODELS_URL) return fetchListing(url, init)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'mini', object: 'model', owned_by: 'opencode' }],
          }),
        ),
      )
    }) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow(/go\.training/)
  })

  it('throws when a listed id has no api entry', async () => {
    stubFetch()
    const fetchListing = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url) !== OPENCODE_GO_MODELS_URL) return fetchListing(url, init)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'mini',
                object: 'model',
                owned_by: 'opencode',
                go: { training: false },
              },
            ],
          }),
        ),
      )
    }) as typeof fetch
    await expect(provider.fetchSpec({})).rejects.toThrow(
      'opencode-go: mini has no api entry',
    )
  })
})
