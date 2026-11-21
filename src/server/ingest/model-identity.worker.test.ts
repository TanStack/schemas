import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { anthropicProvider } from '#/server/providers/anthropic.ts'
import { geminiProvider } from '#/server/providers/gemini.ts'
import { openaiProvider } from '#/server/providers/openai.ts'
import { openrouterProvider } from '#/server/providers/openrouter.ts'
import { provider as vercel } from '#/server/providers/adapters/vercel.ts'
import { provider as azure } from '#/server/providers/adapters/azure.ts'
import { provider as groq } from '#/server/providers/adapters/groq.ts'
import { provider as huggingface } from '#/server/providers/adapters/huggingface.ts'
import { provider as lovable } from '#/server/providers/adapters/lovable.ts'
import { provider as novita } from '#/server/providers/adapters/novita.ts'
import { provider as perplexity } from '#/server/providers/adapters/perplexity.ts'
import { provider as together } from '#/server/providers/adapters/together.ts'
import { namespacedUpstreamIdentity } from '#/server/providers/upstream-model.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { GPT_4O } from '../../../packages/rate-card/src/fixtures/gpt-4o.ts'
import {
  modelDbId,
  pollAllProviders,
  pollProviderModels,
} from './poll-models.ts'
import type { SyncDeps } from './sync.ts'
import { ownNamespaces, reconcileSameAs } from './model-identity.ts'

const SOURCE = {
  derivation: 'listing' as const,
  sourceUrl: 'https://example.com/models',
  path: 'data[].id',
}
const NOW = 1_781_150_100

function deps(): SyncDeps {
  let now = 1_781_150_000
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: {}, now: () => now++ }
}

function stub(
  id: string,
  listed: Array<ModelInfo>,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    displayName: id,
    specSourceUrl: `https://example.com/${id}`,
    defaultDerivation: 'upstream-spec',
    fetchSpec: async () => ({
      specs: [],
      sources: [],
      outputStrategy: 'post-200',
    }),
    listModels: async () => ({ models: listed }),
    classify: () => null,
    ...extra,
  }
}

const identify = (rawId: string) => namespacedUpstreamIdentity(rawId, SOURCE)
const gateway = { upstreamModelIdentity: identify }

function linkChanges(d: SyncDeps, subjectId: string) {
  return d.db
    .select()
    .from(changes)
    .where(
      and(
        eq(changes.subjectId, subjectId),
        eq(changes.summary, 'Upstream model link updated'),
      ),
    )
}

describe('sameAs links', () => {
  it('links when the upstream arrives later, without touching the row or repeating the event', async () => {
    const d = deps()
    const makerId = 'identity-new-maker'
    const resellerId = 'identity-new-reseller'
    const rawId = 'publisher/native-alias'
    const rowId = modelDbId(resellerId, rawId)
    const row = () =>
      d.db.query.models.findFirst({ where: eq(models.id, rowId) })
    const reseller = stub(resellerId, [{ rawId, contextWindow: 1234 }], gateway)
    await pollProviderModels(d, reseller)
    await reconcileSameAs(d.db, NOW)
    const before = await row()
    expect(before).toMatchObject({
      upstreamProvider: 'publisher',
      upstreamRawId: 'native-alias',
      upstreamSource: SOURCE,
      sameAsModelId: null,
    })
    const unresolved = await getModelDetail(d.db, resellerId, rawId)
    expect(unresolved?.sameAs).toBeNull()
    expect(unresolved?.factSources).not.toHaveProperty('sameAs')

    const native = {
      rawId: 'native-dated',
      aliases: ['native-alias'],
      pricing: GPT_4O,
      contextWindow: 200_000,
    }
    const claim = { modelNamespaces: ['publisher'] }
    await pollProviderModels(d, stub(makerId, [native], claim))
    await reconcileSameAs(d.db, NOW)
    const targetId = modelDbId(makerId, native.rawId)
    // The link is the only thing that changes on the reseller's row.
    expect(await row()).toEqual({ ...before, sameAsModelId: targetId })
    const linked = await getModelDetail(d.db, resellerId, rawId)
    expect(linked?.sameAs).toEqual({ provider: makerId, rawId: native.rawId })
    expect(linked?.pricing).toBeNull()
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.factSources?.sameAs).toEqual(SOURCE)
    const [event, ...extra] = await linkChanges(d, rowId)
    expect(extra).toHaveLength(0)
    expect(event).toMatchObject({
      type: 'model.updated',
      providerId: resellerId,
      payload: {
        before: { sameAsModelId: null },
        after: { sameAsModelId: targetId },
      },
    })

    expect((await pollProviderModels(d, reseller)).updated).toBe(0)
    await reconcileSameAs(d.db, NOW)
    // A delisted upstream is deprecated, not deleted: the row still exists.
    await pollProviderModels(d, stub(makerId, [], claim))
    await reconcileSameAs(d.db, NOW)
    expect((await row())?.sameAsModelId).toBe(targetId)
    expect(await linkChanges(d, rowId)).toHaveLength(1)

    // The provider stops stating an upstream: evidence and link both go.
    await pollProviderModels(
      d,
      stub(resellerId, [{ rawId, contextWindow: 1234 }]),
    )
    await reconcileSameAs(d.db, NOW)
    expect(await row()).toMatchObject({
      upstreamProvider: null,
      upstreamRawId: null,
      upstreamSource: null,
      sameAsModelId: null,
    })
    expect(await linkChanges(d, rowId)).toHaveLength(2)
  })

  it('resolves namespaces through the database and prefers exact ids, then aliases, then dots as hyphens', async () => {
    const d = deps()
    await pollProviderModels(
      d,
      stub(
        'identity-a',
        [
          { rawId: 'model', aliases: ['ambiguous'] },
          { rawId: 'other', aliases: ['ambiguous', 'model'] },
          { rawId: 'model-x' },
          { rawId: 'v-4-5-dated', aliases: ['v-4-5'] },
          { rawId: 'v.1' },
          { rawId: 'v-1' },
          { rawId: 'dup-a', aliases: ['dup-1'] },
          { rawId: 'dup-b', aliases: ['dup-1'] },
        ],
        { modelNamespaces: ['shared-publisher'] },
      ),
    )
    // A second claimant makes the namespace ambiguous; a provider id still
    // beats a namespace of the same name.
    const rival = (modelNamespaces: Array<string>) =>
      pollProviderModels(
        d,
        stub('identity-b', [{ rawId: 'model' }], { modelNamespaces }),
      )
    await rival(['shared-publisher', 'identity-a'])
    const host = 'identity-host'
    await pollProviderModels(
      d,
      stub(
        host,
        [
          'identity-a/model',
          'identity-a/ambiguous',
          'identity-a/MODEL-X',
          'identity-a/model:free',
          'identity-a/v-4.5',
          'identity-a/v.1',
          'identity-a/dup.1',
          'identity-unlisted/model',
          'shared-publisher/model',
        ].map((rawId) => ({ rawId })),
        gateway,
      ),
    )
    // A row whose own alias matches its stated upstream must not self-link.
    await pollProviderModels(
      d,
      stub(
        'identity-self',
        [{ rawId: 'identity-self/m', aliases: ['m'] }],
        gateway,
      ),
    )
    // No stated upstream: left to the name tier (issue #719).
    await pollProviderModels(
      d,
      stub('identity-unproven-host', [{ rawId: 'identity-a/model' }]),
    )
    await reconcileSameAs(d.db, NOW)

    const detail = (provider: string, rawId: string) =>
      getModelDetail(d.db, provider, rawId)
    for (const [rawId, target] of [
      ['identity-a/model', 'model'],
      ['identity-a/v.1', 'v.1'],
    ] as const) {
      const exact = await detail(host, rawId)
      expect(exact?.sameAs).toEqual({ provider: 'identity-a', rawId: target })
      expect(exact?.factSources?.sameAs).toEqual(SOURCE)
    }
    const normalized = await detail(host, 'identity-a/v-4.5')
    expect(normalized?.sameAs).toEqual({
      provider: 'identity-a',
      rawId: 'v-4-5-dated',
    })
    expect(normalized?.factSources?.sameAs).toEqual({
      ...SOURCE,
      normalized: true,
    })
    for (const rawId of [
      'identity-a/ambiguous',
      'identity-a/MODEL-X',
      'identity-a/model:free',
      'identity-a/dup.1',
      'identity-unlisted/model',
      'shared-publisher/model',
    ]) {
      expect((await detail(host, rawId))?.sameAs).toBeNull()
    }
    expect(
      (await detail('identity-self', 'identity-self/m'))?.sameAs,
    ).toBeNull()
    // No stated upstream, and the one candidate's chain ends at a row of a
    // provider not declared a maker: a host's row is no origin, no link.
    const inferred = await detail('identity-unproven-host', 'identity-a/model')
    expect(inferred?.sameAs).toBeNull()
    expect(inferred?.factSources?.sameAs).toBeUndefined()

    // Dropping the rival claim from config removes its row, so the namespace
    // resolves again.
    await rival([])
    await reconcileSameAs(d.db, NOW)
    expect((await detail(host, 'shared-publisher/model'))?.sameAs).toEqual({
      provider: 'identity-a',
      rawId: 'model',
    })
  })

  it('writes every link when one run changes more than a batch', async () => {
    const d = deps()
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`)
    await pollProviderModels(
      d,
      stub(
        'identity-bulk-maker',
        ids.map((rawId) => ({ rawId })),
      ),
    )
    await pollProviderModels(
      d,
      stub(
        'identity-bulk-host',
        ids.map((id) => ({ rawId: `identity-bulk-maker/${id}` })),
        gateway,
      ),
    )
    await reconcileSameAs(d.db, NOW)
    const rows = await d.db
      .select()
      .from(models)
      .where(eq(models.providerId, 'identity-bulk-host'))
    expect(rows.filter((row) => row.sameAsModelId !== null)).toHaveLength(12)
    expect(
      await d.db
        .select()
        .from(changes)
        .where(eq(changes.providerId, 'identity-bulk-host')),
    ).toHaveLength(12 * 2) // model.added + the link
  })

  it('resolves links at the end of a poll run, whatever order providers poll in', async () => {
    const d = deps()
    const outcomes = await pollAllProviders(d, [
      stub('identity-run-host', [{ rawId: 'identity-run-maker/m' }], gateway),
      stub('identity-run-maker', [{ rawId: 'm' }]),
    ])
    expect(outcomes.map((outcome) => outcome.failures)).toEqual([0, 0])
    const rowId = modelDbId('identity-run-host', 'identity-run-maker/m')
    const row = await d.db.query.models.findFirst({
      where: eq(models.id, rowId),
    })
    expect(row?.sameAsModelId).toBe(modelDbId('identity-run-maker', 'm'))
    expect(await linkChanges(d, rowId)).toHaveLength(1)
  })

  it("keeps a failed reconcile out of the providers' poll outcomes", async () => {
    // The clock is read once per provider poll, then once by the reconcile
    // step, so failing the second read fails only the reconcile.
    let reads = 0
    const d: SyncDeps = {
      ...deps(),
      now: () => {
        if (++reads > 1) throw new Error('reconcile failed')
        return NOW
      },
    }
    const outcomes = await pollAllProviders(d, [
      stub('identity-run-solo', [{ rawId: 'm' }]),
    ])
    expect(outcomes).toMatchObject([{ failures: 0, added: 1 }])
  })

  it('enforces the target foreign key and rejects a self link', async () => {
    const d = deps()
    await pollProviderModels(d, stub('identity-fk', [{ rawId: 'model' }]))
    const id = modelDbId('identity-fk', 'model')
    await expect(
      d.db
        .update(models)
        .set({ sameAsModelId: 'does-not-exist' })
        .where(eq(models.id, id)),
    ).rejects.toThrow()
    await expect(
      d.db.update(models).set({ sameAsModelId: id }).where(eq(models.id, id)),
    ).rejects.toThrow()
    await expect(
      d.db
        .update(models)
        .set({ upstreamProvider: 'half-an-identity' })
        .where(eq(models.id, id)),
    ).rejects.toThrow()
  })

  it('links OpenRouter, Vercel, and Azure rows to the upstream they state (#199)', async () => {
    const d = deps()
    const pollFixture = (p: ProviderConfig, listed: Array<ModelInfo>) =>
      pollProviderModels(d, {
        ...p,
        listModels: async () => ({ models: listed }),
      })
    await pollFixture(anthropicProvider, [
      {
        rawId: 'claude-opus-4-5-20251101',
        aliases: ['claude-opus-4-5'],
        pricing: GPT_4O,
      },
      { rawId: 'claude-fable-5' },
    ])
    await pollFixture(openaiProvider, [{ rawId: 'gpt-4o-2024-11-20' }])
    await pollFixture(geminiProvider, [{ rawId: 'gemini-2.5-pro' }])
    // Ids as the gateways publish them: dotted versions, `google` for Gemini.
    await pollFixture(openrouterProvider, [
      { rawId: 'anthropic/claude-opus-4.5', contextWindow: 1234 },
      { rawId: 'anthropic/claude-opus-4.5:batch' },
      { rawId: 'anthropic/claude-fable-5' },
      { rawId: 'claude-opus-4-5' },
      { rawId: 'openai/missing-native-model' },
    ])
    await pollFixture(vercel, [
      { rawId: 'google/gemini-2.5-pro' },
      { rawId: 'anthropic/claude-opus-4.5' },
    ])
    await pollFixture(azure, [{ rawId: 'gpt-4o-2024-11-20' }])
    await reconcileSameAs(d.db, NOW)

    const opus = 'claude-opus-4-5-20251101'
    const cases = [
      ['openrouter', 'anthropic/claude-opus-4.5', 'anthropic', opus, 'listing'],
      [
        'openrouter',
        'anthropic/claude-fable-5',
        'anthropic',
        'claude-fable-5',
        'listing',
      ],
      ['vercel', 'anthropic/claude-opus-4.5', 'anthropic', opus, 'listing'],
      [
        'vercel',
        'google/gemini-2.5-pro',
        'gemini',
        'gemini-2.5-pro',
        'listing',
      ],
      [
        'azure',
        'gpt-4o-2024-11-20',
        'openai',
        'gpt-4o-2024-11-20',
        'docs-derived',
      ],
    ] as const
    for (const [provider, rawId, upstream, nativeId, derivation] of cases) {
      const result = await getModelDetail(d.db, provider, rawId)
      expect(result?.sameAs).toEqual({ provider: upstream, rawId: nativeId })
      expect(result?.factSources?.sameAs?.derivation).toBe(derivation)
      // Only the dotted spelling needed normalizing.
      expect(
        (result?.factSources?.sameAs as { normalized?: true } | undefined)
          ?.normalized,
      ).toBe(rawId.endsWith('4.5') ? true : undefined)
    }
    const linked = await getModelDetail(
      d.db,
      'openrouter',
      'anthropic/claude-opus-4.5',
    )
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.pricing).toBeNull()
    // A stated id that matches nothing is never linked by name; a variant
    // the listing does not state stays unlinked.
    for (const rawId of [
      'anthropic/claude-opus-4.5:batch',
      'openai/missing-native-model',
    ]) {
      const unlinked = await getModelDetail(d.db, 'openrouter', rawId)
      expect(unlinked?.sameAs).toBeNull()
      expect(unlinked?.factSources?.sameAs).toBeUndefined()
    }
    // A bare id states nothing: the name tier links it to Anthropic's row.
    const bare = await getModelDetail(d.db, 'openrouter', 'claude-opus-4-5')
    expect(bare?.sameAs).toEqual({ provider: 'anthropic', rawId: opus })
    expect(bare?.factSources?.sameAs).toEqual({
      derivation: 'name-inferred',
      key: 'claude-opus-4-5',
      candidates: [
        { provider: 'anthropic', rawId: opus },
        { provider: 'vercel', rawId: 'anthropic/claude-opus-4.5' },
      ],
    })
  })
})

describe("a host's own namespace states no upstream", () => {
  it('stores no evidence for an id in the host namespace, for every adapter on the shared helper', async () => {
    const d = deps()
    // Real listed ids, 2026-11-21. Only OpenRouter, Groq and Perplexity
    // list ids in their own namespace today; the others show the stated
    // upstream is untouched.
    const cases: Array<[ProviderConfig, string, string | null]> = [
      [groq, 'groq/compound', null],
      [groq, 'groq/compound-mini', null],
      [groq, 'openai/gpt-oss-120b', 'openai'],
      [openrouterProvider, 'openrouter/auto', null],
      [openrouterProvider, 'openrouter/free', null],
      [openrouterProvider, 'moonshotai/kimi-k3', 'moonshotai'],
      [perplexity, 'perplexity/glm-5.3', null],
      [perplexity, 'openai/gpt-6.2-sol', 'openai'],
      [vercel, 'perplexity/sonar', 'perplexity'],
      [together, 'moonshotai/Kimi-K3', 'moonshotai'],
      [huggingface, 'zai-org/GLM-5.3', 'zai-org'],
      [novita, 'deepseek/deepseek-v4-pro', 'deepseek'],
      [lovable, 'openai/gpt-5.5', 'openai'],
    ]
    for (const adapter of new Set(cases.map(([p]) => p))) {
      await pollProviderModels(d, {
        ...adapter,
        listModels: async () => ({
          models: cases
            .filter(([p]) => p === adapter)
            .map(([, rawId]) => ({ rawId })),
        }),
      })
    }
    for (const [p, rawId, upstream] of cases) {
      const [row] = await d.db
        .select()
        .from(models)
        .where(eq(models.id, modelDbId(p.id, rawId)))
      expect([p.id, rawId, row?.upstreamProvider]).toEqual([
        p.id,
        rawId,
        upstream,
      ])
      if (upstream === null) expect(row?.upstreamSource).toBeNull()
    }
    // Now unstated, the row goes to the name tier, which finds no maker row
    // named `compound` or `auto`; neither host is a declared maker.
    await reconcileSameAs(d.db, NOW)
    for (const [p, rawId] of [
      [groq, 'groq/compound'],
      [openrouterProvider, 'openrouter/auto'],
    ] as const) {
      const detail = await getModelDetail(d.db, p.id, rawId)
      expect(detail?.sameAs).toBeNull()
      expect(detail?.firstParty).toBeNull()
    }
  })

  it('clears self evidence a row already holds', async () => {
    const d = deps()
    await pollProviderModels(d, stub('groq', [{ rawId: 'groq/compound' }]))
    const id = modelDbId('groq', 'groq/compound')
    await d.db
      .update(models)
      .set({
        upstreamProvider: 'groq',
        upstreamRawId: 'compound',
        upstreamSource: SOURCE,
      })
      .where(eq(models.id, id))
    await pollProviderModels(d, {
      ...groq,
      listModels: async () => ({ models: [{ rawId: 'groq/compound' }] }),
    })
    const [row] = await d.db.select().from(models).where(eq(models.id, id))
    expect(row?.upstreamProvider).toBeNull()
    expect(row?.upstreamRawId).toBeNull()
  })

  it("resolves the host's names from the providers and namespace tables", async () => {
    const d = deps()
    await pollProviderModels(d, {
      ...geminiProvider,
      listModels: async () => ({ models: [] }),
    })
    await pollProviderModels(d, {
      ...vercel,
      listModels: async () => ({ models: [] }),
    })
    expect(await ownNamespaces(d.db, 'gemini')).toEqual(
      new Set(['gemini', 'google', 'google-ai-studio']),
    )
    expect(await ownNamespaces(d.db, 'vercel')).toEqual(new Set(['vercel']))
  })
})

describe('name-inferred links and chain roots (#719)', () => {
  const pollFixture = (
    d: SyncDeps,
    p: ProviderConfig,
    listed: Array<ModelInfo>,
  ) =>
    pollProviderModels(d, {
      ...p,
      listModels: async () => ({ models: listed }),
    })
  const maker = { makesOwnModels: true }
  const row = (d: SyncDeps, provider: string, rawId: string) =>
    d.db.query.models.findFirst({
      where: eq(models.id, modelDbId(provider, rawId)),
    })

  it("links Neon's bare Claude id to Anthropic's row, labelled name-inferred", async () => {
    const d = deps()
    await pollFixture(d, anthropicProvider, [{ rawId: 'claude-fable-5' }])
    await pollFixture(d, openrouterProvider, [
      { rawId: 'anthropic/claude-fable-5' },
    ])
    await pollProviderModels(d, stub('neon', [{ rawId: 'claude-fable-5' }]))
    await pollProviderModels(
      d,
      stub('identity-opencode', [{ rawId: 'Claude-Fable-5' }]),
    )
    await reconcileSameAs(d.db, NOW)

    const neon = await getModelDetail(d.db, 'neon', 'claude-fable-5')
    expect(neon?.sameAs).toEqual({
      provider: 'anthropic',
      rawId: 'claude-fable-5',
    })
    expect(neon?.sameAsRoot).toEqual(neon?.sameAs)
    expect(neon?.factSources?.sameAs).toEqual({
      derivation: 'name-inferred',
      key: 'claude-fable-5',
      candidates: [
        { provider: 'anthropic', rawId: 'claude-fable-5' },
        { provider: 'openrouter', rawId: 'anthropic/claude-fable-5' },
      ],
    })
    expect(neon?.firstParty).toBe(false)
    // Lowercase applies in the name tier: another bare host links too, and
    // never through Neon's inferred row.
    expect(
      (await getModelDetail(d.db, 'identity-opencode', 'Claude-Fable-5'))
        ?.factSources?.sameAs,
    ).toMatchObject({ derivation: 'name-inferred', key: 'claude-fable-5' })
    // The maker's own row is never linked by name.
    const own = await getModelDetail(d.db, 'anthropic', 'claude-fable-5')
    expect(own?.sameAs).toBeNull()
    expect(own?.firstParty).toBe(true)
    expect(own?.factSources?.firstParty).toEqual({
      decidedBy: 'linked-from',
      count: 3,
    })
    const [event, ...extra] = await linkChanges(
      d,
      modelDbId('neon', 'claude-fable-5'),
    )
    expect(extra).toHaveLength(0)
    expect(event?.payload).toMatchObject({
      after: {
        sameAsModelId: modelDbId('anthropic', 'claude-fable-5'),
        rootModelId: null,
      },
    })
    // A second run with nothing new writes nothing.
    await reconcileSameAs(d.db, NOW)
    expect(
      await linkChanges(d, modelDbId('neon', 'claude-fable-5')),
    ).toHaveLength(1)
  })

  it('never falls through to the name tier when stated evidence resolves to nothing', async () => {
    const d = deps()
    await pollProviderModels(
      d,
      stub('identity-ns-maker', [{ rawId: 'llama-9-70b' }], maker),
    )
    // Groq-like: states `meta-llama`, which no provider claims.
    await pollProviderModels(
      d,
      stub('identity-ns-host', [{ rawId: 'meta-llama/llama-9-70b' }], gateway),
    )
    await reconcileSameAs(d.db, NOW)
    const stated = await row(d, 'identity-ns-host', 'meta-llama/llama-9-70b')
    expect(stated).toMatchObject({
      upstreamProvider: 'meta-llama',
      sameAsModelId: null,
      sameAsInference: null,
    })
  })

  it('links only to a maker row, never to a host row a chain ends at', async () => {
    const d = deps()
    // dashscope / dashscope-cn: neither is a declared maker. Gateways state
    // a namespace the first claims, so their chains end at its row.
    await pollProviderModels(
      d,
      stub('identity-ds', [{ rawId: 'glm-9-prime' }], {
        modelNamespaces: ['identity-ds-ns'],
      }),
    )
    await pollProviderModels(
      d,
      stub(
        'identity-ds-gateway',
        [{ rawId: 'identity-ds-ns/glm-9-prime' }],
        gateway,
      ),
    )
    await pollProviderModels(
      d,
      stub('identity-ds-cn', [{ rawId: 'glm-9-prime' }]),
    )
    // A mixed maker: one row's maker names someone else, and a hosted row
    // its maker source never read is no root either.
    const madeElsewhere = {
      maker: 'Elsewhere Labs',
      factSources: {
        maker: { derivation: 'docs-derived' as const, path: 'Provider' },
      },
    }
    await pollProviderModels(
      d,
      stub(
        'identity-mixed',
        [{ rawId: 'third-9', ...madeElsewhere }, { rawId: 'oss-9-hosted' }],
        maker,
      ),
    )
    await pollProviderModels(
      d,
      stub('identity-mixed-bare', [{ rawId: 'oss-9-hosted' }]),
    )
    await reconcileSameAs(d.db, NOW)
    expect(
      (await row(d, 'identity-ds-gateway', 'identity-ds-ns/glm-9-prime'))
        ?.sameAsModelId,
    ).toBe(modelDbId('identity-ds', 'glm-9-prime'))
    for (const [provider, rawId] of [
      ['identity-ds-cn', 'glm-9-prime'],
      ['identity-mixed-bare', 'oss-9-hosted'],
    ] as const) {
      expect(await row(d, provider, rawId)).toMatchObject({
        sameAsModelId: null,
        sameAsInference: null,
      })
    }
    // A host's link target is not first-party; nor is the mixed maker's
    // unread row.
    expect(
      (await getModelDetail(d.db, 'identity-ds', 'glm-9-prime'))?.firstParty,
    ).toBeNull()
    expect(
      (await getModelDetail(d.db, 'identity-mixed', 'oss-9-hosted'))
        ?.firstParty,
    ).toBeNull()
  })

  it('writes no link when the candidates lead to two roots (regional twins)', async () => {
    const d = deps()
    for (const twin of ['identity-twin', 'identity-twin-cn'])
      await pollProviderModels(d, stub(twin, [{ rawId: 'kimi-k9' }], maker))
    await pollProviderModels(d, stub('identity-bare', [{ rawId: 'kimi-k9' }]))
    await reconcileSameAs(d.db, NOW)
    expect(await row(d, 'identity-bare', 'kimi-k9')).toMatchObject({
      sameAsModelId: null,
      sameAsInference: null,
    })
    // Neither twin links to the other: a declared maker is never a source.
    expect((await row(d, 'identity-twin', 'kimi-k9'))?.sameAsModelId).toBeNull()
  })

  it('links to the root that every candidate leads to, and serves a three-hop root', async () => {
    const d = deps()
    await pollProviderModels(
      d,
      stub('identity-maker', [{ rawId: 'opus-9' }], maker),
    )
    // Azure-like: states the maker.
    await pollProviderModels(
      d,
      stub('identity-cloud', [{ rawId: 'identity-maker/opus-9' }], gateway),
    )
    // LLM Gateway-like: states the cloud's id.
    await pollProviderModels(
      d,
      stub(
        'identity-router',
        [{ rawId: 'identity-cloud/identity-maker/opus-9' }],
        gateway,
      ),
    )
    // A fourth host behind the router.
    await pollProviderModels(
      d,
      stub(
        'identity-edge',
        [{ rawId: 'identity-router/identity-cloud/identity-maker/opus-9' }],
        gateway,
      ),
    )
    await pollProviderModels(d, stub('identity-bare', [{ rawId: 'OPUS.9' }]))
    await reconcileSameAs(d.db, NOW)

    const root = { provider: 'identity-maker', rawId: 'opus-9' }
    const edge = await getModelDetail(
      d.db,
      'identity-edge',
      'identity-router/identity-cloud/identity-maker/opus-9',
    )
    expect(edge?.sameAs).toEqual({
      provider: 'identity-router',
      rawId: 'identity-cloud/identity-maker/opus-9',
    })
    expect(edge?.sameAsRoot).toEqual(root)
    const router = await getModelDetail(
      d.db,
      'identity-router',
      'identity-cloud/identity-maker/opus-9',
    )
    expect(router?.sameAsRoot).toEqual(root)
    // The bare id matches the maker's row and the cloud's row (key opus-9),
    // and both lead to one root.
    const bare = await getModelDetail(d.db, 'identity-bare', 'OPUS.9')
    expect(bare?.sameAs).toEqual(root)
    expect(bare?.factSources?.sameAs).toMatchObject({ key: 'opus-9' })
    const maker9 = await getModelDetail(d.db, 'identity-maker', 'opus-9')
    expect(maker9?.factSources?.firstParty).toEqual({
      decidedBy: 'linked-from',
      count: 4,
    })
  })

  it('refuses a looping chain and a candidate that leads back to the row', async () => {
    const d = deps()
    // Two hosts that each state the other's row, and a third behind one of
    // them: no chain has a root, so none of them links.
    const states = (providerNamespace: string, rawId: string) => ({
      providerNamespace,
      rawId,
      source: SOURCE,
    })
    await pollProviderModels(
      d,
      stub('identity-loop-a', [
        { rawId: 'a1', upstream: states('identity-loop-b', 'b1') },
      ]),
    )
    await pollProviderModels(
      d,
      stub('identity-loop-b', [
        { rawId: 'b1', upstream: states('identity-loop-a', 'a1') },
      ]),
    )
    await pollProviderModels(
      d,
      stub('identity-loop-c', [
        { rawId: 'c1', upstream: states('identity-loop-a', 'a1') },
      ]),
    )
    // A bare id matching the looping rows has no root either.
    await pollProviderModels(d, stub('identity-loop-bare', [{ rawId: 'b1' }]))
    // The only candidate for `back` is a stated row whose chain ends at
    // `back` itself.
    await pollProviderModels(d, stub('identity-back', [{ rawId: 'w' }]))
    await pollProviderModels(
      d,
      stub('identity-front', [{ rawId: 'identity-back/w' }], gateway),
    )
    await reconcileSameAs(d.db, NOW)
    for (const [provider, rawId] of [
      ['identity-loop-a', 'a1'],
      ['identity-loop-b', 'b1'],
      ['identity-loop-c', 'c1'],
      ['identity-loop-bare', 'b1'],
    ] as const) {
      expect(await row(d, provider, rawId)).toMatchObject({
        sameAsModelId: null,
        rootModelId: null,
      })
    }
    expect(
      (await row(d, 'identity-front', 'identity-back/w'))?.sameAsModelId,
    ).toBe(modelDbId('identity-back', 'w'))
    expect(await row(d, 'identity-back', 'w')).toMatchObject({
      sameAsModelId: null,
      sameAsInference: null,
    })
  })

  it('strips a variant the listing states, records it, and a stated link beats an inferred one', async () => {
    const d = deps()
    await pollFixture(d, anthropicProvider, [{ rawId: 'claude-opus-5' }])
    const variant = {
      providerNamespace: 'anthropic',
      rawId: 'claude-opus-5',
      source: { ...SOURCE, path: 'data[].canonical_slug', variant: 'batch' },
    }
    await pollFixture(d, openrouterProvider, [
      { rawId: 'anthropic/claude-opus-5' },
      { rawId: 'anthropic/claude-opus-5:batch', upstream: variant },
    ])
    // A host that states an upstream for one id and nothing for another
    // with the same name.
    await pollProviderModels(
      d,
      stub('identity-mixed-host', [
        { rawId: 'claude-opus-5' },
        {
          rawId: 'opus-house-blend',
          upstream: { ...variant, source: SOURCE },
        },
      ]),
    )
    await reconcileSameAs(d.db, NOW)
    const batch = await getModelDetail(
      d.db,
      'openrouter',
      'anthropic/claude-opus-5:batch',
    )
    expect(batch?.sameAs).toEqual({
      provider: 'anthropic',
      rawId: 'claude-opus-5',
    })
    expect(batch?.factSources?.sameAs).toEqual(variant.source)
    const stated = await getModelDetail(
      d.db,
      'identity-mixed-host',
      'opus-house-blend',
    )
    expect(stated?.factSources?.sameAs).toEqual(SOURCE)
    const named = await getModelDetail(
      d.db,
      'identity-mixed-host',
      'claude-opus-5',
    )
    expect(named?.factSources?.sameAs?.derivation).toBe('name-inferred')

    // The host starts stating the upstream for the bare id: the stated link
    // replaces the inference.
    await pollProviderModels(
      d,
      stub('identity-mixed-host', [
        { rawId: 'claude-opus-5', upstream: { ...variant, source: SOURCE } },
        {
          rawId: 'opus-house-blend',
          upstream: { ...variant, source: SOURCE },
        },
      ]),
    )
    await reconcileSameAs(d.db, NOW)
    expect(await row(d, 'identity-mixed-host', 'claude-opus-5')).toMatchObject({
      sameAsInference: null,
    })
    expect(
      (await getModelDetail(d.db, 'identity-mixed-host', 'claude-opus-5'))
        ?.factSources?.sameAs,
    ).toEqual(SOURCE)
  })
})
