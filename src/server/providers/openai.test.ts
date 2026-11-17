import { expect, it, vi } from 'vitest'
import {
  OPENAI_GPT51_GUIDE_URL,
  OPENAI_GPT52_GUIDE_URL,
  OPENAI_GPT5_GUIDE_URL,
} from './openai-gpt5-guides.ts'
import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_MODEL_PAGE,
  OPENAI_PRICING_URL,
} from './openai-model-docs.ts'
import { OPENAI_REALTIME_EFFORT_URL } from './openai-realtime-efforts.ts'
import { openaiProvider } from './openai.ts'

it('loads the docs through the US egress (#505)', async () => {
  const original = globalThis.fetch
  // The listing itself stays on the global fetch; a docs load there fails.
  globalThis.fetch = ((url: string) =>
    String(url).includes('developers.openai.com')
      ? Promise.reject(new Error(`global fetch called for ${String(url)}`))
      : Promise.resolve(
          Response.json({
            data: [{ id: 'gpt-5-mini' }, { id: 'gpt-realtime-2' }],
          }),
        )) as typeof fetch
  const egressed: Array<string> = []
  const ns = {
    idFromName: () => 'id',
    get: () => ({
      fetch(url: string) {
        egressed.push(String(url))
        if (url === OPENAI_MODELS_INDEX_URL)
          return Promise.resolve(
            new Response('- [GPT-5 mini](/api/docs/models/gpt-5-mini.md)'),
          )
        return Promise.resolve(new Response('# Docs'))
      },
    }),
  }
  try {
    const result = await openaiProvider.listModels({
      OPENAI_API_KEY: 'test-key',
      US_EGRESS: ns as unknown as DurableObjectNamespace,
    })
    for (const failure of result.docsFailures?.first ?? []) {
      expect(failure.error).not.toMatch(/global fetch called/)
    }
    expect(egressed).toEqual(
      expect.arrayContaining([
        OPENAI_MODELS_INDEX_URL,
        OPENAI_PRICING_URL,
        OPENAI_MODEL_PAGE('gpt-5-mini'),
        OPENAI_REALTIME_EFFORT_URL,
        OPENAI_GPT5_GUIDE_URL,
        OPENAI_GPT51_GUIDE_URL,
        OPENAI_GPT52_GUIDE_URL,
      ]),
    )
  } finally {
    globalThis.fetch = original
  }
})

/** Listing answers from `responses` in order; docs loads get an empty page. */
async function listWithListing(responses: Array<() => Response>) {
  const original = globalThis.fetch
  const auth: Array<string | null> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).includes('developers.openai.com'))
      return Promise.resolve(new Response('# Docs'))
    auth.push(new Headers(init?.headers).get('authorization'))
    const next = responses[auth.length - 1]
    if (!next) throw new Error('listing called more often than stubbed')
    return Promise.resolve(next())
  }) as typeof fetch
  vi.useFakeTimers()
  try {
    const settled = openaiProvider
      .listModels({ OPENAI_API_KEY: 'test-key' })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
    await vi.runAllTimersAsync()
    return { auth, ...(await settled) }
  } finally {
    vi.useRealTimers()
    globalThis.fetch = original
  }
}

const gatewayTimeout = () =>
  new Response('error code: 504', {
    status: 504,
    statusText: 'Gateway Timeout',
  })

it('retries a 504 on the listing (#100004)', async () => {
  const out = await listWithListing([
    gatewayTimeout,
    () => Response.json({ data: [{ id: 'gpt-5-mini' }] }),
  ])
  expect('result' in out && out.result.models.map((m) => m.rawId)).toEqual([
    'gpt-5-mini',
  ])
  expect(out.auth).toEqual(['Bearer test-key', 'Bearer test-key'])
})

it('throws with the URL when every listing attempt is a 504', async () => {
  const out = await listWithListing(
    Array.from({ length: 5 }, () => gatewayTimeout),
  )
  expect('error' in out && String(out.error)).toMatch(
    /fetch failed after 5 attempts: https:\/\/api\.openai\.com\/v1\/models → 504 Gateway Timeout/,
  )
})
