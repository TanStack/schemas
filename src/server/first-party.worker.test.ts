import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '#/db/index.ts'
import { getModelDetail, listProviderModels } from '#/server/catalog.ts'
import { reconcileSameAs } from '#/server/ingest/model-identity.ts'
import { pollProviderModels } from '#/server/ingest/poll-models.ts'
import type { SyncDeps } from '#/server/ingest/sync.ts'
import { anthropicProvider } from '#/server/providers/anthropic.ts'
import { byteplusProvider } from '#/server/providers/byteplus.ts'
import { geminiProvider } from '#/server/providers/gemini.ts'
import {
  groqMakerFacts,
  provider as groq,
} from '#/server/providers/adapters/groq.ts'
import {
  mistralMakerFacts,
  provider as mistral,
} from '#/server/providers/adapters/mistral.ts'
import { provider as bedrock } from '#/server/providers/adapters/amazon-bedrock.ts'
import type {
  FactSource,
  ModelInfo,
  ProviderConfig,
} from '#/server/providers/types.ts'

function deps(): SyncDeps {
  let now = 1_781_150_000
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: {}, now: () => now++ }
}

const poll = (d: SyncDeps, p: ProviderConfig, listed: Array<ModelInfo>) =>
  pollProviderModels(d, { ...p, listModels: async () => ({ models: listed }) })

const docs = (path: string): FactSource => ({
  derivation: 'docs-derived',
  sourceUrl: 'https://example.com/makers',
  path,
})

const makers = {
  byId: { 'zai-glm-5-3': 'Z.ai' },
  named: ['zai-glm-5-3', 'mistral-large-latest'],
  hash: 'h',
}

describe('firstParty (#719)', () => {
  it('follows the acceptance list in the issue', async () => {
    const d = deps()
    await poll(d, anthropicProvider, [
      { rawId: 'claude-fable-5' },
      // No other host lists this one yet.
      { rawId: 'claude-solo-1' },
    ])
    await poll(d, bedrock, [{ rawId: 'anthropic.claude-fable-5-v1:0' }])
    await pollProviderModels(d, {
      id: 'neon',
      displayName: 'Neon',
      specSourceUrl: 'https://example.com/neon',
      defaultDerivation: 'upstream-spec',
      fetchSpec: async () => ({
        specs: [],
        sources: [],
        outputStrategy: 'post-200',
      }),
      listModels: async () => ({ models: [{ rawId: 'claude-fable-5' }] }),
      classify: () => null,
    })
    await poll(d, geminiProvider, [
      { rawId: 'gemini-9-pro' },
      {
        rawId: 'gemma-4-31b-it',
        maker: 'Google DeepMind',
        factSources: { maker: docs('Authors') },
      },
    ])
    await poll(d, mistral, [
      { rawId: 'zai-glm-5-3', ...mistralMakerFacts('zai-glm-5-3', makers) },
      {
        rawId: 'mistral-large-latest',
        ...mistralMakerFacts('mistral-large-latest', makers),
      },
      // The overview does not list this one: not read, so not claimed.
      {
        rawId: 'mistral-unlisted',
        ...mistralMakerFacts('mistral-unlisted', makers),
      },
    ])
    await poll(d, byteplusProvider, [
      {
        rawId: 'deepseek-v4-pro-ga-260813',
        maker: 'DeepSeek',
        factSources: { maker: docs('Provider') },
      },
      {
        rawId: 'seed-2-0-pro-260328',
        maker: 'ByteDance',
        factSources: { maker: docs('Provider') },
      },
      { rawId: 'gpt-oss-120b-250805' },
    ])
    await poll(d, groq, [
      {
        rawId: 'meta-llama/llama-9-70b',
        ...groqMakerFacts({ owned_by: 'Meta' }),
      },
      { rawId: 'meta-llama/llama-9-8b', ...groqMakerFacts({ owned_by: '' }) },
    ])
    await reconcileSameAs(d.db, 1_781_150_100)

    const party = async (provider: string, rawId: string) => {
      const row = await getModelDetail(d.db, provider, rawId)
      return { value: row?.firstParty, source: row?.factSources?.firstParty }
    }
    const anthropic = await listProviderModels(d.db, 'anthropic')
    expect(anthropic?.models.map((row) => row.firstParty)).toEqual([true, true])
    expect(await party('anthropic', 'claude-solo-1')).toEqual({
      value: true,
      source: { decidedBy: 'provider-declared' },
    })
    expect(await party('anthropic', 'claude-fable-5')).toEqual({
      value: true,
      source: { decidedBy: 'linked-from', count: 2 },
    })
    for (const [provider, rawId] of [
      ['neon', 'claude-fable-5'],
      ['amazon-bedrock', 'anthropic.claude-fable-5-v1:0'],
    ] as const) {
      expect(await party(provider, rawId)).toEqual({
        value: false,
        source: { decidedBy: 'same-as' },
      })
    }
    // Google DeepMind names gemini through its `google` namespace.
    expect(await party('gemini', 'gemma-4-31b-it')).toEqual({
      value: true,
      source: { decidedBy: 'provider-declared' },
    })
    expect((await party('mistral', 'zai-glm-5-3')).value).toBe(false)
    expect(await party('mistral', 'mistral-large-latest')).toMatchObject({
      value: true,
      source: { decidedBy: 'maker', source: { path: 'unstated' } },
    })
    expect((await party('mistral', 'mistral-unlisted')).value).toBeNull()
    expect((await party('byteplus', 'gpt-oss-120b-250805')).value).toBeNull()
    expect((await party('byteplus', 'deepseek-v4-pro-ga-260813')).value).toBe(
      false,
    )
    // ByteDance names byteplus through its `bytedance` namespace.
    expect((await party('byteplus', 'seed-2-0-pro-260328')).value).toBe(true)
    expect(await party('groq', 'meta-llama/llama-9-70b')).toMatchObject({
      value: false,
      source: { decidedBy: 'maker', source: { path: 'owned_by' } },
    })
    expect(await party('groq', 'meta-llama/llama-9-8b')).toEqual({
      value: null,
      source: undefined,
    })
  })
})
