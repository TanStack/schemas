/**
 * Pins the completeness scorer's `originLink` to the link rules: one table
 * of cases runs through `reconcileSameAs` (stated tiers, then the name tier
 * `inferLinks`), the catalog serves the rows, and `scoreRow` must say a row
 * needs a link exactly when the rules wrote one.
 */
import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq, isNotNull } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { models } from '#/db/schema.ts'
import { buildReport, scoreRow } from '#/lib/completeness.ts'
import type { ModelRow } from '#/lib/completeness.ts'
import { listModelsCatalog } from '#/server/catalog.ts'
import { namespacedUpstreamIdentity } from '#/server/providers/upstream-model.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { modelDbId, pollProviderModels } from './poll-models.ts'
import type { SyncDeps } from './sync.ts'
import { reconcileSameAs } from './model-identity.ts'

const SOURCE = {
  derivation: 'listing' as const,
  sourceUrl: 'https://example.com/models',
  path: 'data[].id',
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

const maker = { makesOwnModels: true }
const gateway = {
  upstreamModelIdentity: (rawId: string) =>
    namespacedUpstreamIdentity(rawId, SOURCE),
}

/** [provider, rawId, needs a link]: the rules' answer for each case. */
const CASES: Record<string, Array<readonly [string, string, boolean]>> = {
  // dashscope / dashscope-cn: shared ids, neither a declared maker.
  'regional twins, no maker': [
    ['ols-ds', 'qwen9-max', false],
    ['ols-ds-cn', 'qwen9-max', false],
  ],
  // Two declared twins: a bare host's candidates lead to two roots.
  'regional twins, two roots': [
    ['ols-kimi', 'kimi-k9', false],
    ['ols-kimi-cn', 'kimi-k9', false],
    ['ols-host-a', 'kimi-k9', false],
  ],
  'three-hop chain': [
    ['ols-maker', 'opus-9', false],
    ['ols-cloud', 'ols-maker/opus-9', true],
    ['ols-router', 'ols-cloud/ols-maker/opus-9', true],
    ['ols-edge', 'ols-router/ols-cloud/ols-maker/opus-9', true],
  ],
  'host-only model': [
    ['ols-host-a', 'llama-9-70b', false],
    ['ols-host-b', 'llama-9-70b', false],
  ],
  "maker's own row": [['ols-maker', 'sonnet-9', false]],
  // The name would match the maker, but stated evidence never falls through.
  'stated evidence that resolves to nothing': [['ols-stated', 'opus-9', false]],
  'variant suffix': [['ols-gw', 'ols-maker/opus-9:batch', true]],
  'case-only difference': [['ols-bare', 'OPUS-9', true]],
}

async function seed(d: SyncDeps) {
  const poll = (p: ProviderConfig) => pollProviderModels(d, p)
  await poll(stub('ols-ds', [{ rawId: 'qwen9-max' }]))
  await poll(stub('ols-ds-cn', [{ rawId: 'qwen9-max' }]))
  await poll(stub('ols-kimi', [{ rawId: 'kimi-k9' }], maker))
  await poll(stub('ols-kimi-cn', [{ rawId: 'kimi-k9' }], maker))
  await poll(
    stub('ols-host-a', [{ rawId: 'kimi-k9' }, { rawId: 'llama-9-70b' }]),
  )
  await poll(stub('ols-host-b', [{ rawId: 'llama-9-70b' }]))
  await poll(
    stub('ols-maker', [{ rawId: 'opus-9' }, { rawId: 'sonnet-9' }], maker),
  )
  await poll(stub('ols-cloud', [{ rawId: 'ols-maker/opus-9' }], gateway))
  await poll(
    stub('ols-router', [{ rawId: 'ols-cloud/ols-maker/opus-9' }], gateway),
  )
  await poll(
    stub(
      'ols-edge',
      [{ rawId: 'ols-router/ols-cloud/ols-maker/opus-9' }],
      gateway,
    ),
  )
  await poll(
    stub('ols-stated', [
      {
        rawId: 'opus-9',
        upstream: {
          providerNamespace: 'ols-nowhere',
          rawId: 'opus-9',
          source: SOURCE,
        },
      },
    ]),
  )
  await poll(
    stub('ols-gw', [
      {
        rawId: 'ols-maker/opus-9:batch',
        upstream: {
          providerNamespace: 'ols-maker',
          rawId: 'opus-9',
          source: { ...SOURCE, variant: 'batch' },
        },
      },
    ]),
  )
  await poll(stub('ols-bare', [{ rawId: 'OPUS-9' }]))
}

describe('originLink need agrees with the links reconcileSameAs writes', () => {
  it.each(Object.entries(CASES))('%s', async (_, rows) => {
    let now = 1_781_150_000
    const d: SyncDeps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => now++,
    }
    await seed(d)
    await reconcileSameAs(d.db, now)
    const served = (await listModelsCatalog(d.db, { pricing: true }))
      .models as Array<ModelRow>
    for (const [provider, rawId, expected] of rows) {
      const stored = await d.db.query.models.findFirst({
        where: eq(models.id, modelDbId(provider, rawId)),
      })
      const row = served.find(
        (r) => r.provider === provider && r.rawId === rawId,
      )
      if (!stored || !row) throw new Error(`${provider}/${rawId} not seeded`)
      const needs = scoreRow(row).some((f) => f.fact === 'originLink')
      const label = `${provider}/${rawId}`
      expect({ label, linked: stored.sameAsModelId !== null }).toEqual({
        label,
        linked: expected,
      })
      expect({ label, needs }).toEqual({ label, needs: expected })
    }
    // The catalog-wide report agrees too: it counts no row the rules left
    // unlinked, however many providers list the same name.
    const report = buildReport(served)
    for (const provider of new Set(rows.map(([p]) => p))) {
      const linked = await d.db.$count(
        models,
        and(eq(models.providerId, provider), isNotNull(models.sameAsModelId)),
      )
      expect(
        report.providers.find((p) => p.provider === provider)?.originLink,
      ).toEqual({ have: linked, need: linked, modelSilent: 0 })
    }
  })
})
