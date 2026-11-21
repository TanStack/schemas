import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ModelFacts from './model-facts.ts'
import { provider } from './dashscope-cn.ts'

vi.mock('./model-facts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFacts>()),
  cachedDocs: (_kv: unknown, _url: string, load: () => Promise<unknown>) =>
    load(),
}))
afterEach(() => vi.unstubAllGlobals())
describe('DashScope CN public native adapter', () => {
  it('needs no international key and uses only owned Chinese sources', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      expect(url).toMatch(/^https:\/\/help\.aliyun\.com\/zh\/model-studio\//)
      const file = new URL(url).pathname.split('/').at(-1)
      return Promise.resolve(
        new Response(
          readFileSync(
            new URL(`./fixtures/dashscope-cn/${file}.txt`, import.meta.url),
          ),
        ),
      )
    })
    const listed = await provider.listModels({})
    expect(listed.models.length).toBeGreaterThan(400)
    expect(
      listed.models.find((model) => model.rawId === 'qwen-flash')?.pricing,
    ).not.toBeNull()
    // The compat page's supported-models line binds the stated route.
    const route = (id: string) =>
      listed.models.find((model) => model.rawId === id)?.schemaEndpointId
    expect(route('qwen-flash')).toBe('compatible-mode/v1/chat/completions')
    expect(
      listed.models.find((model) => model.rawId === 'qwen-flash')?.factSources
        ?.schemaEndpointId,
    ).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl:
        'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope.md',
    })
    // Qwen-Audio is named as not compatible; QwQ and supplier-prefixed ids
    // are not matched by the line's family names, so they stay unbound.
    expect(route('qwen-audio-turbo')).toBeFalsy()
    expect(route('qwq-plus')).toBeFalsy()
    expect(route('siliconflow/deepseek-v3.2')).toBeFalsy()
    // Qwen-Audio with version digits; realtime.md (WebSocket/WebRTC) and
    // qwen-deep-research.md (no OpenAI-compatible interface) name these.
    expect(route('qwen2-audio-instruct')).toBeFalsy()
    expect(route('qwen3.8-omni-flash-realtime')).toBeFalsy()
    expect(route('qwen-omni-turbo-realtime-latest')).toBeFalsy()
    expect(route('qwen-deep-research')).toBeFalsy()
    // A non-realtime Omni model still binds.
    expect(route('qwen3-omni-flash')).toBe(
      'compatible-mode/v1/chat/completions',
    )
    const chat = listed.models.filter((model) => model.activity === 'chat')
    const bound = chat.filter((model) => model.schemaEndpointId)
    expect(bound).toHaveLength(159)
    expect(
      listed.models.some(
        (model) => model.activity !== 'chat' && model.schemaEndpointId,
      ),
    ).toBe(false)
    const spec = await provider.fetchSpec({})
    expect(spec.sources).toHaveLength(5)
    expect(
      spec.sources.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash)),
    ).toBe(true)
    expect(spec.skipped).toBeUndefined()
    expect(Object.keys(spec.specs[0]?.paths ?? {})).toEqual([
      '/compatible-mode/v1/chat/completions',
    ])
    expect(urls).toHaveLength(12)
    expect(provider.generationEndpointId).toBeUndefined()
  })
  it('binds no chat row while an exclusion page is unreadable', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      const file = new URL(url).pathname.split('/').at(-1)
      if (file === 'realtime.md')
        return Promise.resolve(new Response('# 其他页面\n'))
      return Promise.resolve(
        new Response(
          readFileSync(
            new URL(`./fixtures/dashscope-cn/${file}.txt`, import.meta.url),
          ),
        ),
      )
    })
    const listed = await provider.listModels({})
    const chat = listed.models.filter((model) => model.activity === 'chat')
    expect(chat.some((model) => model.schemaEndpointId)).toBe(false)
    expect(
      chat.every((model) => model.absent?.schemaEndpointId === 'unavailable'),
    ).toBe(true)
    expect(listed.docsFailures?.failed).toBe(1)
  })
  it('does not replace failed native fetches with Intl metadata or empty catalogs', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    )
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    await expect(provider.fetchSpec({})).rejects.toThrow(/503/)
  })
})

it('rejects a successful wrong native page rather than retaining partial facts', async () => {
  vi.stubGlobal('fetch', (url: string) => {
    const file = new URL(url).pathname.split('/').at(-1)
    let text = readFileSync(
      new URL(`./fixtures/dashscope-cn/${file}.txt`, import.meta.url),
      'utf8',
    )
    if (file === 'qwen-flash.md')
      text = text.replace('# qwen-flash', '# unrelated')
    return Promise.resolve(new Response(text))
  })
  await expect(provider.listModels({})).rejects.toThrow(
    'malformed native source',
  )
})
