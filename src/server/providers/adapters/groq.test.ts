import { describe, expect, it } from 'vitest'

import listing from '../fixtures/groq-models-owned-by.json'
import { groqMakerFacts, provider } from './groq.ts'

describe('groq classify', () => {
  it('maps generation paths and drops platform surfaces', () => {
    expect(provider.classify('/openai/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/openai/v1/responses', {})).toBe('chat')
    expect(provider.classify('/openai/v1/audio/speech', {})).toBe('audio')
    expect(provider.classify('/openai/v1/audio/transcriptions', {})).toBe(
      'audio',
    )
    expect(provider.classify('/openai/v1/audio/translations', {})).toBe('audio')
    expect(provider.classify('/openai/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/openai/v1/batches', {})).toBeNull()
    expect(provider.classify('/openai/v1/files', {})).toBeNull()
    expect(provider.classify('/openai/v1/reranking', {})).toBeNull()
    expect(provider.classify('/v1/fine_tunings', {})).toBeNull()
    expect(provider.classify('/openai/v1/models', {})).toBeNull()
  })
})

describe('groq listModels', () => {
  it('skips with an empty catalog when GROQ_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('groq: GROQ_API_KEY not set — skipped')
  })
})

describe('groq upstream identity', () => {
  it('states the maker an id names, and nothing for a bare id', () => {
    // Ids from the live listing, 2026-11-21.
    expect(provider.upstreamModelIdentity?.('openai/gpt-oss-120b')).toEqual({
      providerNamespace: 'openai',
      rawId: 'gpt-oss-120b',
      source: {
        derivation: 'listing',
        sourceUrl: 'https://api.groq.com/openai/v1/models',
        path: 'data[].id',
      },
    })
    expect(
      provider.upstreamModelIdentity?.('meta-llama/llama-prompt-guard-2-86m'),
    ).toMatchObject({
      providerNamespace: 'meta-llama',
      rawId: 'llama-prompt-guard-2-86m',
    })
    expect(provider.upstreamModelIdentity?.('whisper-large-v3')).toBeNull()
    expect(provider.upstreamModelIdentity?.('allam-2-7b')).toBeNull()
  })
})

describe('groq fetchSpec', () => {
  const spec = {
    openapi: '3.0.1',
    info: { title: 'GroqCloud API' },
    paths: { '/openai/v1/chat/completions': { post: { summary: 'chat' } } },
  }

  const mockScript = (embedded: string | null): string =>
    embedded === null
      ? '#!/usr/bin/env bash'
      : `#!/usr/bin/env bash\n  EMBEDDED_SPEC="${embedded}"`

  async function withScript<T>(
    script: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === provider.specSourceUrl
          ? new Response(script)
          : new Response('not found', { status: 404 }),
      )) as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  async function gzipBase64(text: string): Promise<string> {
    const bytes = new Uint8Array(
      await new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    )
    return btoa(String.fromCharCode(...bytes))
  }

  it('decodes the base64+gzip EMBEDDED_SPEC from scripts/mock', async () => {
    const script = mockScript(await gzipBase64(JSON.stringify(spec)))
    const fetched = await withScript(script, () => provider.fetchSpec({}))
    expect(fetched.outputStrategy).toBe('post-200')
    expect(fetched.specs[0]?.info?.title).toBe('GroqCloud API')
    expect(fetched.sources[0]?.url).toBe(provider.specSourceUrl)
    expect(fetched.specRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(fetched.specRevision).toBe(fetched.sources[0]?.hash)
  })

  it('throws when EMBEDDED_SPEC is missing', async () => {
    await expect(
      withScript(mockScript(null), () => provider.fetchSpec({})),
    ).rejects.toThrow(/groq: no EMBEDDED_SPEC/)
  })

  it('throws when EMBEDDED_SPEC is not gzip', async () => {
    await expect(
      withScript(mockScript(btoa('plain text')), () => provider.fetchSpec({})),
    ).rejects.toThrow(/not gzipped JSON/)
  })
})

describe('groq maker (#710)', () => {
  const byId = new Map(listing.data.map((row) => [row.id, row]))

  it('reads owned_by as written (live listing, 2026-11-21)', () => {
    const facts = (id: string) => groqMakerFacts(byId.get(id) ?? {})
    expect(facts('openai/gpt-oss-120b').maker).toBe('OpenAI')
    expect(facts('qwen/qwen3.8-27b').maker).toBe('Alibaba Cloud')
    expect(facts('allam-2-7b').maker).toBe('SDAIA')
    expect(facts('meta-llama/llama-prompt-guard-2-86m')).toEqual({
      maker: 'Meta',
      factSources: {
        maker: {
          derivation: 'listing',
          sourceUrl: 'https://api.groq.com/openai/v1/models',
          path: 'owned_by',
        },
      },
    })
  })

  it('says a row with no owned_by names no maker', () => {
    expect(groqMakerFacts({ owned_by: ' ' })).toMatchObject({
      maker: null,
      factSources: { maker: { path: 'unstated' } },
    })
  })
})
