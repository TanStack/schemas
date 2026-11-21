import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ModelFacts from './model-facts.ts'
import { provider as cnProvider } from './adapters/kimi-code-plan-cn.ts'
import { provider as globalProvider } from './adapters/kimi-code-plan-global.ts'
import { KIMI_CODE_MODELS_URL } from './kimi-code-docs.ts'

vi.mock('./model-facts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFacts>()),
  cachedDocs: (_kv: unknown, _url: string, load: () => Promise<unknown>) =>
    load(),
}))
// Captured 2026-11-21: the Base URLs table names Chat Completions.
const html = readFileSync(
  new URL('./fixtures/kimi-code-models-2026-11-21.html.txt', import.meta.url),
  'utf8',
)
afterEach(() => vi.unstubAllGlobals())

describe('Kimi Coding regional adapters', () => {
  it('loads shared native docs for both documented regions and stores only the stated route', async () => {
    const urls: Array<string> = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      if (url !== KIMI_CODE_MODELS_URL)
        throw new Error(`unexpected source ${url}`)
      return Promise.resolve(new Response(html))
    })
    const cn = cnProvider
    const global = globalProvider
    const cnModels = (await cn.listModels({})).models
    const globalModels = (await global.listModels({})).models
    expect(cnModels.map((model) => model.rawId)).toEqual(
      globalModels.map((model) => model.rawId),
    )
    for (const [models, region] of [
      [cnModels, 'China'],
      [globalModels, 'Overseas'],
    ] as const) {
      expect(models).toHaveLength(6)
      for (const model of models) {
        expect(model.schemaEndpointId).toBe('coding/v1/chat/completions')
        expect(model.factSources?.schemaEndpointId).toMatchObject({
          derivation: 'docs-derived',
          sourceUrl: KIMI_CODE_MODELS_URL,
          path: `Base URLs; Chat Completions; ${region}`,
        })
      }
    }
    for (const provider of [cn, global]) {
      const spec = await provider.fetchSpec({})
      expect(spec.skipped).toBeUndefined()
      // Route-only: the docs state the path, not a request schema.
      const paths = spec.specs[0]?.paths ?? {}
      expect(Object.keys(paths)).toEqual(['/coding/v1/chat/completions'])
      expect(paths['/coding/v1/chat/completions']?.post).toMatchObject({
        'x-modelschemas-route-only': true,
        responses: {},
      })
    }
    expect(urls).toEqual(Array(4).fill(KIMI_CODE_MODELS_URL))
    const models = (await cn.listModels({})).models
    expect(
      models.every(
        (model) =>
          model.pricing === null && model.absent?.pricing === 'cleared',
      ),
    ).toBe(true)
    const spec = await cn.fetchSpec({})
    expect(spec.sources).toHaveLength(1)
    expect(spec.sources[0]?.url).toBe(KIMI_CODE_MODELS_URL)
    expect(spec.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects malformed native docs during both listing and spec refresh', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>missing model table</html>')),
    )
    const provider = cnProvider
    await expect(provider.listModels({})).rejects.toThrow()
    await expect(provider.fetchSpec({})).rejects.toThrow()
  })
  it('fails native source fetches instead of returning an empty successful catalog', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('upstream unavailable', { status: 503 })),
    )
    const provider = cnProvider
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    await expect(provider.fetchSpec({})).rejects.toThrow(/503/)
  })
})
