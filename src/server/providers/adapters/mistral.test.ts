import { readFileSync } from 'node:fs'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import {
  MISTRAL_WEBSEARCH_GUIDE,
  mistralModelPage,
  tip,
} from '../fixtures/mistral-model-page.ts'
import { mistralAliasFacts, provider } from './mistral.ts'
import { MISTRAL_DEPRECATIONS_URL } from '../deprecations.ts'
import {
  MISTRAL_WEBSEARCH_URL,
  mistralSummaryMaker,
  parseMistralMakers,
  parseMistralMarkdownReleaseDate,
} from '../mistral-pricing.ts'
import { MISTRAL_REASONING_URL } from '../reasoning-config.ts'

const MODELS_PAGE = readFileSync(
  new URL('../fixtures/mistral-models.md.txt', import.meta.url),
  'utf8',
)
// https://docs.mistral.ai/models/mistral-small-4-0-26-03.md, 2026-11-21.
const SMALL_4_MARKDOWN = readFileSync(
  new URL('../fixtures/mistral-small-4-0-26-03.md.txt', import.meta.url),
  'utf8',
)

describe('mistral classify', () => {
  it('maps generation paths to the claimed activities', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/fim/completions', {})).toBe('chat')
    expect(provider.classify('/v1/agents/completions', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/chat/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/v1/audio/transcriptions#stream', {})).toBe(
      'audio',
    )
    expect(provider.classify('/v1/audio/speech', {})).toBe('audio')
  })

  it('drops platform, admin, files, fine-tune, batch, and classifiers that are not moderation', () => {
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.classify('/v1/fine_tuning/models/{model_id}', {}),
    ).toBeNull()
    expect(provider.classify('/v1/batch/jobs', {})).toBeNull()
    expect(provider.classify('/v1/admin/users', {})).toBeNull()
    expect(provider.classify('/v1/agents', {})).toBeNull()
    expect(provider.classify('/v1/conversations', {})).toBeNull()
    expect(provider.classify('/v1/ocr', {})).toBeNull()
    expect(provider.classify('/v1/classifications', {})).toBeNull()
    expect(provider.classify('/v1/chat/classifications', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('mistral listModels', () => {
  it('skips with an empty catalog when MISTRAL_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('mistral: MISTRAL_API_KEY not set — skipped')
  })

  it('maps live rows and sends the bearer key', async () => {
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      calls.push({
        url: href,
        auth: new Headers(init?.headers).get('authorization'),
      })
      if (href === MISTRAL_DEPRECATIONS_URL) {
        return Promise.resolve(new Response(MODELS_PAGE))
      }
      // Docs stay off the network. A live pricing table plus one page
      // per slug blows the 5s test limit once missing ids pull markdown.
      if (!href.startsWith('https://api.mistral.ai/')) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mistral-small-latest', created: 1_700_000_000 },
              { id: 'mistral-embed' },
            ],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const { models, skipped, deprecations } = await provider.listModels({
        MISTRAL_API_KEY: 'mistral-test',
      })
      expect(skipped).toBeUndefined()
      expect(
        deprecations?.find((entry) => entry.rawId === 'pixtral-12b-2409')
          ?.replacedBy,
      ).toEqual(['ministral-14b-2512'])
      expect(calls[0]?.url).toBe('https://api.mistral.ai/v1/models')
      expect(calls[0]?.auth).toBe('Bearer mistral-test')
      expect(
        models.map(
          ({
            pricing: _pricing,
            factSources: _sources,
            reasoning: _reasoning,
            modalities: _modalities,
            serverTools: _tools,
            maxOutput: _maxOutput,
            requestMap: _requestMap,
            absent: _absent,
            ...rest
          }) => rest,
        ),
      ).toEqual([
        // `created` is the request time on every row (#708), not a date.
        // Neither id is in the overview's API name column: no maker fact.
        { rawId: 'mistral-small-latest', releasedAt: null, activity: null },
        { rawId: 'mistral-embed', releasedAt: null, activity: 'embeddings' },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral listModels modalities', () => {
  it('puts the modalities a model page states on the rows it names', async () => {
    const pages: Record<string, string> = {
      'https://api.mistral.ai/v1/models': JSON.stringify({
        data: [
          {
            id: 'mistral-small-latest',
            capabilities: { completion_chat: true },
            aliases: ['mistral-vibe-cli-fast'],
          },
          {
            id: 'mistral-vibe-cli-fast',
            capabilities: { completion_chat: true },
            aliases: ['mistral-small-latest'],
          },
          { id: 'mistral-unpriced', capabilities: { completion_chat: true } },
        ],
      }),
      'https://docs.mistral.ai/inference/pricing': `<h2>Flagship models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/mistral-small-4-0-26-03">Small</a></td><td>$0.1</td><td>—</td><td>$0.3</td></tr>
</table>`,
      'https://docs.mistral.ai/resources/changelogs': '',
      [MISTRAL_WEBSEARCH_URL]: MISTRAL_WEBSEARCH_GUIDE,
      'https://docs.mistral.ai/models/mistral-small-4-0-26-03':
        mistralModelPage(
          ['mistral-small-2603', 'mistral-small-latest'],
          [
            [
              tip('Text input'),
              tip('Image input'),
              tip('Reasoning output'),
              tip('Text output'),
            ],
          ],
        ),
      'https://docs.mistral.ai/models/mistral-small-4-0-26-03.md':
        SMALL_4_MARKDOWN,
      [MISTRAL_REASONING_URL]:
        '- `mistral-small-latest`: Supports adjustable reasoning via the `reasoning_effort` parameter.',
      'https://docs.mistral.ai/models':
        '| [Nope](/models/not-a-listed-id) | `not-a-listed-id` | GA |',
      'https://docs.mistral.ai/openapi.yaml': `components:
  schemas:
    ChatCompletionRequest:
      additionalProperties: false
      properties:
        max_tokens: { type: integer }
        reasoning_effort: { type: string }
        messages:
          items:
            discriminator:
              propertyName: role
              mapping:
                system: '#/components/schemas/SystemMessage'
                user: '#/components/schemas/UserMessage'
                assistant: '#/components/schemas/AssistantMessage'
                tool: '#/components/schemas/ToolMessage'
`,
    }
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body = pages[String(url)]
      return Promise.resolve(
        body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(body),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({ MISTRAL_API_KEY: 'k' })
      const [small, vibe, unpriced] = models
      expect(small?.modalities).toEqual({
        input: ['text', 'image'],
        output: ['text'],
      })
      expect(small?.factSources?.modalities).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
        path: 'modalities',
      })
      expect(small?.pricing).toBeTruthy()
      expect(small?.requestMap).toMatchObject({
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: true,
        thinking: { on: { reasoning_effort: 'high' }, off: null, levels: null },
      })
      expect(small?.factSources?.requestMap).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://docs.mistral.ai/openapi.yaml',
      })
      // The page names only small-latest. The listing says vibe is that model.
      expect(vibe?.modalities).toEqual(small?.modalities)
      expect(vibe?.pricing).toEqual(small?.pricing)
      expect(vibe?.factSources?.modalities?.sourceUrl).toBe(
        'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
      )
      // The markdown twin's `Release date: 2026-03-16` (#708).
      expect(small?.releasedAt).toBe(Date.UTC(2026, 2, 16) / 1000)
      expect(small?.factSources?.releasedAt).toMatchObject({
        derivation: 'docs-derived',
        sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03.md',
        path: 'Release date',
      })
      expect(vibe?.releasedAt).toBe(small?.releasedAt)
      expect(unpriced?.releasedAt).toBeNull()
      // No page names this id: unknown, not a guess, and not a cleared price.
      expect(unpriced?.modalities).toBeUndefined()
      expect(unpriced?.factSources?.modalities).toBeUndefined()
      expect(unpriced?.absent).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral medium 3.5 alias prices (#785)', () => {
  it('gives listing aliases the named id’s catalog card when another alias disagrees', async () => {
    const record = (overrides: Record<string, unknown>) => ({
      slug: 'mistral-medium-3-5-26-04',
      status: 'deprecated',
      modelIds: ['mistral-medium-3-5', 'mistral-medium-latest'],
      shortDescription: '',
      deprecatedAt: '2026-10-31T00:00:00.000Z',
      retiredAt: null,
      replacedBy: null,
      inputs: ['text'],
      outputs: ['text'],
      features: [],
      maxOutputTokens: null,
      releasedAt: '2026-04-28T00:00:00.000Z',
      pricing: [
        {
          direction: 'input',
          label: 'Input',
          unit: '/M Tokens',
          priceUsd: 1.5,
        },
        {
          direction: 'output',
          label: 'Output',
          unit: '/M Tokens',
          priceUsd: 7.5,
        },
      ],
      isFree: false,
      ...overrides,
    })
    const catalogHtml = (models: Array<unknown>) => {
      const stream = `1:${JSON.stringify(models)}\n`
      return `<html><a href="/models/mistral-medium-3-5-26-04">Medium</a><script>self.__next_f.push([1,${JSON.stringify(stream)}])</script></html>`
    }
    const medium = record({})
    const successor = record({
      slug: 'mistral-large-4-0',
      status: 'ga',
      modelIds: ['mistral-large-4', 'mistral-large-latest'],
      deprecatedAt: null,
      pricing: [
        {
          direction: 'input',
          label: 'Input',
          unit: '/M Tokens',
          priceUsd: 0.7,
        },
        {
          direction: 'output',
          label: 'Output',
          unit: '/M Tokens',
          priceUsd: 2.1,
        },
      ],
    })
    const magistral = record({
      slug: 'magistral-medium-1-2-25-09',
      status: 'ga',
      modelIds: ['magistral-medium-latest'],
      deprecatedAt: null,
      releasedAt: '2025-09-18T00:00:00.000Z',
      pricing: [
        {
          direction: 'input',
          label: 'Input',
          unit: '/M Tokens',
          priceUsd: 2,
        },
        {
          direction: 'output',
          label: 'Output',
          unit: '/M Tokens',
          priceUsd: 5,
        },
      ],
    })
    const small = record({
      slug: 'mistral-small-4-0-26-03',
      status: 'ga',
      modelIds: ['mistral-small-latest'],
      deprecatedAt: null,
      pricing: [
        {
          direction: 'input',
          label: 'Input',
          unit: '/M Tokens',
          priceUsd: 0.15,
        },
        {
          direction: 'output',
          label: 'Output',
          unit: '/M Tokens',
          priceUsd: 0.6,
        },
      ],
    })
    const magistralSmall = record({
      slug: 'magistral-small-1-2-25-09',
      status: 'ga',
      modelIds: ['magistral-small-latest'],
      deprecatedAt: null,
      pricing: [
        {
          direction: 'input',
          label: 'Input',
          unit: '/M Tokens',
          priceUsd: 0.5,
        },
        {
          direction: 'output',
          label: 'Output',
          unit: '/M Tokens',
          priceUsd: 1.5,
        },
      ],
    })
    const alias = (id: string, name: string, aliases: Array<string>) => ({
      id,
      name,
      aliases,
      capabilities: { completion_chat: true },
    })
    const mediumAliases = [
      'mistral-medium-latest',
      'mistral-medium-2604',
      'mistral-vibe-cli-latest',
      'magistral-medium-latest',
    ]
    const smallAliases = [
      'mistral-small-latest',
      'mistral-vibe-cli-fast',
      'magistral-small-latest',
    ]
    const pages: Record<string, string> = {
      'https://api.mistral.ai/v1/models': JSON.stringify({
        data: [
          alias(
            'mistral-medium-latest',
            'mistral-medium-latest',
            mediumAliases,
          ),
          alias('mistral-medium-2604', 'mistral-medium-latest', mediumAliases),
          alias(
            'mistral-vibe-cli-latest',
            'mistral-medium-latest',
            mediumAliases,
          ),
          alias(
            'magistral-medium-latest',
            'mistral-medium-latest',
            mediumAliases,
          ),
          alias('mistral-small-latest', 'mistral-small-latest', smallAliases),
          alias('mistral-vibe-cli-fast', 'mistral-small-latest', smallAliases),
          alias('magistral-small-latest', 'mistral-small-latest', smallAliases),
        ],
      }),
      'https://docs.mistral.ai/openapi.yaml': `components:
  schemas:
    ChatCompletionRequest:
      properties:
        max_tokens: { type: integer }
`,
      'https://docs.mistral.ai/inference/pricing': `<h2>Flagship models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/mistral-small-4-0-26-03">Small</a></td><td>$0.15</td><td>—</td><td>$0.6</td></tr>
</table>`,
      'https://docs.mistral.ai/resources/changelogs': '',
      [MISTRAL_WEBSEARCH_URL]: MISTRAL_WEBSEARCH_GUIDE,
      'https://docs.mistral.ai/models': catalogHtml([
        medium,
        magistral,
        magistralSmall,
      ]),
      'https://docs.mistral.ai/models/mistral-medium-3-5-26-04': catalogHtml([
        medium,
        successor,
      ]),
      'https://docs.mistral.ai/models/magistral-medium-1-2-25-09': catalogHtml([
        magistral,
      ]),
      'https://docs.mistral.ai/models/mistral-small-4-0-26-03': catalogHtml([
        small,
      ]),
      'https://docs.mistral.ai/models/magistral-small-1-2-25-09': catalogHtml([
        magistralSmall,
      ]),
    }
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body = pages[String(url)]
      return Promise.resolve(
        body === undefined
          ? new Response('missing', { status: 404 })
          : new Response(body),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({
        MISTRAL_API_KEY: 'k',
      })
      const byId = new Map(models.map((model) => [model.rawId, model]))
      const isCard = (value: unknown): value is RateCard =>
        typeof value === 'object' && value !== null && 'price' in value
      const perMillion = (id: string): number => {
        const card = byId.get(id)?.pricing
        if (!isCard(card)) throw new Error(`${id} has no card`)
        return price(
          card,
          {},
          { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        )
      }
      expect(perMillion('mistral-medium-latest')).toBeCloseTo(9, 6)
      expect(perMillion('mistral-medium-2604')).toBeCloseTo(9, 6)
      expect(perMillion('mistral-vibe-cli-latest')).toBeCloseTo(9, 6)
      expect(
        byId.get('mistral-medium-2604')?.factSources?.pricing?.sourceUrl,
      ).toBe('https://docs.mistral.ai/models/mistral-medium-3-5-26-04')
      expect(perMillion('magistral-medium-latest')).toBeCloseTo(7, 6)
      // Live listing names vibe-cli-fast as small, so the medium card is wrong.
      expect(perMillion('mistral-vibe-cli-fast')).toBeCloseTo(0.75, 6)
      expect(perMillion('magistral-small-latest')).toBeCloseTo(2, 6)
      expect(perMillion('mistral-small-latest')).toBeCloseTo(0.75, 6)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral listModels release dates', () => {
  it('lets the listing alias settle an id two pages date differently', async () => {
    const page = (ids: Array<string>) =>
      mistralModelPage(ids, [[tip('Text input'), tip('Audio output')]])
    const pages: Record<string, string> = {
      'https://api.mistral.ai/v1/models': JSON.stringify({
        data: [
          { id: 'voxtral-mini-tts-2603', aliases: ['voxtral-mini-tts-latest'] },
          { id: 'voxtral-mini-tts-latest', aliases: ['voxtral-mini-tts-2603'] },
          { id: 'voxtral-mini-tts-3-0' },
          { id: 'tts-orphan' },
        ],
      }),
      'https://docs.mistral.ai/inference/pricing': `<h2>Audio models</h2>
<p>Prices /M Chars</p>
<table>
<tr><td><a href="/models/voxtral-tts-26-03">TTS</a></td><td>$16</td></tr>
<tr><td><a href="/models/voxtral-mini-tts-3-0">TTS 3</a></td><td>$16</td></tr>
</table>`,
      'https://docs.mistral.ai/resources/changelogs': '',
      [MISTRAL_WEBSEARCH_URL]: MISTRAL_WEBSEARCH_GUIDE,
      // Both pages name `-latest` and `tts-orphan`, with different dates.
      'https://docs.mistral.ai/models/voxtral-tts-26-03': page([
        'voxtral-mini-tts-2603',
        'voxtral-mini-tts-latest',
        'tts-orphan',
      ]),
      'https://docs.mistral.ai/models/voxtral-tts-26-03.md':
        '- Release date: 2026-03-23\n',
      'https://docs.mistral.ai/models/voxtral-mini-tts-3-0': page([
        'voxtral-mini-tts-3-0',
        'voxtral-mini-tts-latest',
        'tts-orphan',
      ]),
      'https://docs.mistral.ai/models/voxtral-mini-tts-3-0.md':
        '- Release date: 2026-10-20\n',
    }
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body = pages[String(url)]
      return Promise.resolve(
        body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(body),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({ MISTRAL_API_KEY: 'k' })
      const byId = new Map(models.map((model) => [model.rawId, model]))
      const latest = byId.get('voxtral-mini-tts-latest')
      // The listing says `-latest` is the 2603 snapshot: its page's date.
      expect(latest?.releasedAt).toBe(Date.UTC(2026, 2, 23) / 1000)
      expect(latest?.factSources?.releasedAt?.sourceUrl).toBe(
        'https://docs.mistral.ai/models/voxtral-tts-26-03.md',
      )
      expect(byId.get('voxtral-mini-tts-3-0')?.releasedAt).toBe(
        Date.UTC(2026, 9, 20) / 1000,
      )
      // Same page conflict, no mutual alias: no date.
      const orphan = byId.get('tts-orphan')
      expect(orphan?.releasedAt).toBeNull()
      expect(orphan?.factSources?.releasedAt).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('parseMistralMarkdownReleaseDate', () => {
  it('reads the page date, null for a page with none, throws on junk', () => {
    expect(parseMistralMarkdownReleaseDate(SMALL_4_MARKDOWN)).toBe(
      Date.UTC(2026, 2, 16) / 1000,
    )
    // Timestral pages state no release date.
    expect(parseMistralMarkdownReleaseDate('- Version: 1.0\n')).toBeNull()
    expect(() =>
      parseMistralMarkdownReleaseDate('- Release date: March 2026\n'),
    ).toThrow(/release date/)
    expect(() =>
      parseMistralMarkdownReleaseDate('- Release date: 2026-02-30\n'),
    ).toThrow(/release date/)
  })
})

describe('mistral listModels docs failures', () => {
  it('keeps stored facts and reports the pages when the docs 404', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href === 'https://api.mistral.ai/v1/models') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'mistral-small-latest',
                  capabilities: { completion_chat: true },
                },
              ],
            }),
          ),
        )
      }
      if (href === 'https://docs.mistral.ai/openapi.yaml') {
        return Promise.resolve(
          new Response(`components:
  schemas:
    ChatCompletionRequest:
      properties:
        max_tokens: { type: integer }
`),
        )
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }) as typeof fetch
    try {
      const { models, docsFailures } = await provider.listModels({
        MISTRAL_API_KEY: 'k',
      })
      expect(models.map((model) => model.rawId)).toEqual([
        'mistral-small-latest',
      ])
      expect(models[0]?.absent).toMatchObject({
        pricing: 'unavailable',
        serverTools: 'unavailable',
        modalities: 'unavailable',
        maxOutput: 'unavailable',
        reasoning: 'unavailable',
        requestMap: 'unavailable',
        maker: 'unavailable',
      })
      expect(models[0]?.requestMap).toBeUndefined()
      expect(docsFailures?.first.map((failure) => failure.source)).toEqual(
        expect.arrayContaining([
          'https://docs.mistral.ai/inference/pricing',
          MISTRAL_REASONING_URL,
          `${MISTRAL_DEPRECATIONS_URL}#makers`,
        ]),
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const fixture = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Mistral AI API', version: '1.0.0' },
      paths: {
        '/v1/chat/completions': { post: { summary: 'Chat Completion' } },
      },
    })
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(fixture))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://docs.mistral.ai/openapi.yaml'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('Mistral AI API')
      expect(fetched.sources[0]?.url).toBe(
        'https://docs.mistral.ai/openapi.yaml',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral provider metadata', () => {
  it('exports the seed fields required for auto-registration', () => {
    expect(provider.id).toBe('mistral')
    expect(provider.displayName).toBe('Mistral')
    expect(provider.authEnvVar).toBe('MISTRAL_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe('https://docs.mistral.ai/openapi.yaml')
    expect(provider.modelsEndpoint).toBe('https://api.mistral.ai/v1/models')
  })
})

describe('mistral alias links (#709)', () => {
  // Trimmed `GET /v1/models` (id, name, aliases), 2026-11-21.
  const listing = JSON.parse(
    readFileSync(
      new URL('../fixtures/mistral-models-aliases.json', import.meta.url),
      'utf8',
    ),
  ) as { data: Array<{ id: string; name: string; aliases: Array<string> }> }
  const facts = new Map(
    listing.data.map((row) => [row.id, mistralAliasFacts(row)]),
  )

  it('lists the stated group and never reads name as a target', () => {
    // The listing's name is `mistral-large-4` on every member: not a target.
    const large = facts.get('mistral-large-latest')
    expect(large?.aliasOf).toBeNull()
    expect(large?.aliases).toEqual(['mistral-large-4', 'mistral-large-4-0'])
    expect(large?.factSources).toEqual({
      aliases: {
        derivation: 'listing',
        sourceUrl: 'https://api.mistral.ai/v1/models',
        path: 'aliases',
      },
      aliasOf: {
        derivation: 'listing',
        sourceUrl: 'https://api.mistral.ai/v1/models',
        path: 'unstated',
      },
    })
    // A dated snapshot does not resolve to a moving alias.
    const dated = facts.get('mistral-medium-2604')
    expect(dated?.aliasOf).toBeNull()
    expect(dated?.aliases).toContain('mistral-medium-latest')
  })

  it('leaves a row with no aliases bare', () => {
    expect(facts.get('mistral-large-2512')).toEqual({})
  })

  it('links every -latest row through its group, target unstated', () => {
    const latest = [...facts].filter(([id]) => id.endsWith('-latest'))
    expect(latest).toHaveLength(18)
    for (const [, row] of latest) {
      expect(row.aliases?.length).toBeGreaterThan(0)
      expect(row.aliasOf).toBeNull()
      expect(row.factSources?.aliasOf?.path).toBe('unstated')
    }
  })
})

describe('mistral maker (#710)', () => {
  const OVERVIEW = readFileSync(
    new URL('../fixtures/mistral-models-makers.md.txt', import.meta.url),
    'utf8',
  )

  it('reads "third-party ... model from X" off the overview (2026-11-21)', () => {
    const { makers, named } = parseMistralMakers(OVERVIEW)
    expect(Object.fromEntries(makers)).toEqual({
      'zai-glm-5-3-flash': 'Z.ai',
      'deepseek-v4-1-flash-1017': 'DeepSeek',
      'zai-glm-5-3': 'Z.ai',
      'zai-glm-5-2': 'Z.ai',
    })
    expect(named.has('mistral-large-4')).toBe(true)
    expect(named.has('mistral-large-2512')).toBe(true)
    expect(named.has('mistral-large-latest')).toBe(false)
  })

  it('ends the name at the sentence and keeps dotted names whole', () => {
    expect(mistralSummaryMaker('A third-party model from xAI.')).toBe('xAI')
    expect(mistralSummaryMaker('A third-party model from 01.AI.')).toBe('01.AI')
    expect(
      mistralSummaryMaker('A third-party model from Z.ai. Great for coding.'),
    ).toBe('Z.ai')
    expect(
      mistralSummaryMaker(
        'A third-party open weight text model from Z.ai with a 1M-token context window.',
      ),
    ).toBe('Z.ai')
    expect(mistralSummaryMaker('A third-party model from Alibaba Cloud')).toBe(
      'Alibaba Cloud',
    )
    expect(mistralSummaryMaker('Mistral Small 4.')).toBeNull()
  })

  it('throws on any other third-party wording', () => {
    for (const summary of [
      'A third-party model built by Z.ai.',
      'A third-party model from the Qwen team at Alibaba Cloud.',
      'Our flagship model. Beats the third-party model from DeepSeek on coding.',
    ]) {
      expect(() => mistralSummaryMaker(summary), summary).toThrow(
        /unreadable third-party summary/,
      )
    }
  })

  it('throws when the overview table is gone', () => {
    expect(() => parseMistralMakers('# Models Overview\n')).toThrow(
      /parsed 0 API slugs/,
    )
  })

  it('names the maker on every alias, says listed Mistral rows state none, says nothing of unlisted ids', async () => {
    const original = globalThis.fetch
    const group = ['zai-glm-5-3', 'zai-glm-5', 'zai-glm-latest']
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href === MISTRAL_DEPRECATIONS_URL) {
        return Promise.resolve(new Response(OVERVIEW))
      }
      if (href !== 'https://api.mistral.ai/v1/models') {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              ...group.map((id) => ({
                id,
                aliases: group.filter((other) => other !== id),
              })),
              { id: 'glm-5-2', aliases: ['zai-glm-5-2'] },
              { id: 'zai-glm-5-2', aliases: ['glm-5-2'] },
              { id: 'mistral-large-4', aliases: ['mistral-large-latest'] },
              { id: 'mistral-large-latest', aliases: ['mistral-large-4'] },
              { id: 'labs-unlisted' },
            ],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({ MISTRAL_API_KEY: 'k' })
      const makers = Object.fromEntries(
        models.map((model) => [
          model.rawId,
          [model.maker, model.factSources?.maker?.path],
        ]),
      )
      expect(makers).toEqual({
        'zai-glm-5-3': ['Z.ai', 'Summary'],
        'zai-glm-5': ['Z.ai', 'Summary'],
        'zai-glm-latest': ['Z.ai', 'Summary'],
        'glm-5-2': ['Z.ai', 'Summary'],
        'zai-glm-5-2': ['Z.ai', 'Summary'],
        'mistral-large-4': [null, 'unstated'],
        'mistral-large-latest': [null, 'unstated'],
        // The overview never lists it: no maker and no source.
        'labs-unlisted': [undefined, undefined],
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
