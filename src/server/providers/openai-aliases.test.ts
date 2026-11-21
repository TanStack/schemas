import { readFileSync } from 'node:fs'

import { requestUrl } from '#/lib/text.ts'
import { afterEach, expect, it } from 'vitest'

import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_MODEL_PAGE,
  openaiModelFacts,
} from './openai-model-docs.ts'
import { docsRun } from './model-facts.ts'

// Trimmed https://developers.openai.com/api/docs/models/gpt-4o.md, 2026-11-21.
const GPT_4O = readFileSync(
  new URL('./fixtures/openai-gpt-4o.md.txt', import.meta.url),
  'utf8',
)

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(page: string | null) {
  globalThis.fetch = (input) => {
    const url = requestUrl(input)
    if (url === OPENAI_MODELS_INDEX_URL) {
      return Promise.resolve(
        new Response('[GPT-4o](/api/docs/models/gpt-4o.md)'),
      )
    }
    if (url === OPENAI_MODEL_PAGE('gpt-4o') && page !== null) {
      return Promise.resolve(new Response(page))
    }
    return Promise.resolve(new Response('outage', { status: 503 }))
  }
}

const listed = [
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-11-20',
  'gpt-5-search-api-2025-10-14',
]

it('links the alias to its default snapshot and says which snapshots have none (#709)', async () => {
  serve(GPT_4O)
  const facts = await openaiModelFacts(listed)
  const url = OPENAI_MODEL_PAGE('gpt-4o')

  const alias = facts('gpt-4o')
  expect(alias.aliasOf).toBe('gpt-4o-2024-08-06')
  expect(alias.factSources?.aliasOf).toMatchObject({
    derivation: 'docs-derived',
    sourceUrl: url,
    path: 'Default snapshot',
  })

  // "Oct 01, 2023 knowledge cutoff" belongs to the Model ID and default
  // snapshot, like the price; an older snapshot may differ.
  expect(alias.knowledgeCutoff).toBe('2023-10-01')
  expect(alias.factSources?.knowledgeCutoff).toMatchObject({
    sourceUrl: url,
    path: 'Knowledge Cutoff',
  })

  const snapshot = facts('gpt-4o-2024-08-06')
  expect(snapshot.knowledgeCutoff).toBe('2023-10-01')
  expect(snapshot.aliases).toEqual(['gpt-4o'])
  expect(snapshot.aliasOf).toBeUndefined()
  expect(snapshot.factSources?.aliases?.path).toBe('Default snapshot')

  // Listed on the page's snapshot list, and no alias resolves to it.
  const older = facts('gpt-4o-2024-11-20')
  expect(older.knowledgeCutoff).toBeNull()
  expect(older.factSources?.knowledgeCutoff).toBeUndefined()
  expect(older.aliases).toBeUndefined()
  expect(older.factSources?.aliases).toMatchObject({
    sourceUrl: url,
    path: 'Snapshots',
  })

  // No page names it: the docs are silent, and say so.
  const unpaged = facts('gpt-5-search-api-2025-10-14')
  expect(unpaged.aliases).toBeUndefined()
  expect(unpaged.factSources?.aliases).toEqual({
    derivation: 'docs-derived',
    sourceUrl: OPENAI_MODELS_INDEX_URL,
    path: 'unstated',
  })
})

it('keeps the stored links when the page fails', async () => {
  serve(null)
  const facts = await openaiModelFacts(listed, undefined, docsRun())
  for (const id of ['gpt-4o', 'gpt-4o-2024-08-06']) {
    expect(facts(id).absent).toMatchObject({
      aliases: 'unavailable',
      aliasOf: 'unavailable',
      knowledgeCutoff: 'unavailable',
    })
  }
})
