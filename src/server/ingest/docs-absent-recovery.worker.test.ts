import { env } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { getDb } from '../../db/index.ts'
import { providers } from '../../db/schema.ts'
import type { ProviderConfig } from '../providers/types.ts'
import { recordDocsFailing, readDocsFailing } from './docs-failing.ts'
import { pollProviderModels } from './poll-models.ts'

it('clears a docs-failing row when listModels omits docsFailures', async () => {
  const id = 'docs-absent'
  const db = getDb(env)
  await db.insert(providers).values({
    id,
    displayName: 'Docs absent',
    specSourceUrl: 'https://example.com/models',
  })
  await recordDocsFailing(
    db,
    id,
    {
      failed: 1,
      skipped: 0,
      first: [
        {
          source: 'https://example.com/docs',
          error: 'privacy training cell "30 days" for Grok 4.7',
          elapsedMs: 1,
        },
      ],
    },
    1794884821,
  )
  expect(await readDocsFailing(db, id)).toMatchObject({
    failed: 1,
    polls: 1,
  })
  const provider: ProviderConfig = {
    id,
    displayName: 'Docs absent',
    defaultDerivation: 'docs-derived',
    fetchSpec: () =>
      Promise.resolve({
        specs: [],
        sources: [],
        outputStrategy: 'post-200',
      }),
    listModels: () =>
      Promise.resolve({ models: [{ rawId: 'grok-4.7', activity: 'chat' }] }),
    classify: () => null,
  }
  const outcome = await pollProviderModels(
    { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => 1794889129 },
    provider,
  )
  expect(outcome.modelsSeen).toBe(1)
  expect(outcome.failures).toBe(0)
  expect(outcome.docsFailures).toBeUndefined()
  expect(outcome.docsFailing).toBeUndefined()
  expect(await readDocsFailing(db, id)).toBeNull()
})
