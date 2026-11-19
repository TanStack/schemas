import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GEMINI_MODELS_INDEX_URL } from './gemini-features.ts'
import { GEMINI_PRICING_URL } from './gemini-pricing.ts'
import { GEMINI_DISCOVERY_URL } from './gemini-request.ts'
import { geminiProvider } from './gemini.ts'

const KEY = 'test-gemini-key-123'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gemini listModels', () => {
  it('sends the key as a header so a failed fetch never quotes it', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (
          !input.startsWith(
            'https://generativelanguage.googleapis.com/v1beta/models?',
          )
        ) {
          // Docs loads run alongside the listing; leave them pending.
          return new Promise<Response>(() => {})
        }
        seen.push({
          url: input,
          key: new Headers(init?.headers).get('x-goog-api-key'),
        })
        return Promise.resolve(
          new Response('bad', { status: 400, statusText: 'Bad Request' }),
        )
      }),
    )

    const error = await geminiProvider.listModels({ GEMINI_API_KEY: KEY }).then(
      () => null,
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('400 Bad Request')
    expect((error as Error).message).not.toContain(KEY)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).not.toContain(KEY)
    expect(seen[0]?.key).toBe(KEY)
  })

  it('writes the listing when the pricing page parses nothing (#567)', async () => {
    vi.stubGlobal('fetch', (input: string) => {
      const url = String(input)
      if (
        url.startsWith(
          'https://generativelanguage.googleapis.com/v1beta/models',
        )
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                {
                  name: 'models/gemini-2.5-flash',
                  displayName: 'Gemini 2.5 Flash',
                  supportedGenerationMethods: ['generateContent'],
                  inputTokenLimit: 1048576,
                  outputTokenLimit: 65536,
                },
              ],
            }),
          ),
        )
      }
      if (url === GEMINI_DISCOVERY_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemas: {
                ThinkingConfig: {
                  properties: { thinkingBudget: { description: 'budget' } },
                },
                Content: {
                  properties: {
                    role: {
                      description: "The role must be either 'user' or 'model'.",
                    },
                  },
                },
              },
            }),
          ),
        )
      }
      if (url === GEMINI_PRICING_URL) {
        return Promise.resolve(new Response('<html><body>moved</body></html>'))
      }
      return Promise.resolve(new Response('moved', { status: 404 }))
    })

    const result = await geminiProvider.listModels({ GEMINI_API_KEY: KEY })

    expect(result.models).toEqual([
      expect.objectContaining({
        rawId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        // The model page is what tells chat from video (#658): unread, the
        // stored activity and route are kept.
        activity: null,
        schemaEndpointId: null,
        contextWindow: 1048576,
        maxOutput: 65536,
        absent: {
          pricing: 'unavailable',
          modalities: 'unavailable',
          serverTools: 'unavailable',
          reasoning: 'unavailable',
          requestMap: 'unavailable',
          activity: 'unavailable',
          schemaEndpointId: 'unavailable',
        },
      }),
    ])
    expect(result.docsFailures?.first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: GEMINI_PRICING_URL,
          error: 'gemini pricing page: parsed 0 model rows',
        }),
      ]),
    )
    expect(result.skipped).toBeUndefined()
  })
})

describe('gemini video models (#658)', () => {
  /** https://aistudio.google.com/docs/models/gemini-omni-flash.md, 2026-11-16. */
  const OMNI_PAGE = readFileSync(
    new URL('./fixtures/gemini-omni-flash.md.txt', import.meta.url),
    'utf8',
  )
  /** https://aistudio.google.com/docs/models/genie-4.md, 2026-11-20. */
  const GENIE_PAGE = readFileSync(
    new URL('./fixtures/gemini-genie-4.md.txt', import.meta.url),
    'utf8',
  )
  const INDEX = `
{% table variant="model" %}
  * Model
  * Endpoint

  ---

  * [Gemini Omni Flash](/docs/models/gemini-omni-flash)
  * \`gemini-omni-1.2-flash\`   
    \`gemini-omni-1.1-flash\`
{% /table %}
`
  // The Models API lists Omni exactly like a chat model.
  const LISTING = JSON.stringify({
    models: [
      {
        name: 'models/gemini-omni-1.2-flash',
        displayName: 'Gemini Omni 1.2 Flash',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
    ],
  })

  function stub(pages: Record<string, string>, listing = LISTING) {
    vi.stubGlobal('fetch', (input: string) => {
      const url = String(input)
      if (
        url.startsWith(
          'https://generativelanguage.googleapis.com/v1beta/models',
        )
      ) {
        return Promise.resolve(new Response(listing))
      }
      if (url === GEMINI_DISCOVERY_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemas: {
                ThinkingConfig: {
                  properties: { thinkingBudget: { description: 'budget' } },
                },
              },
            }),
          ),
        )
      }
      const body = pages[url]
      return Promise.resolve(
        body === undefined
          ? new Response('missing', { status: 500 })
          : new Response(body),
      )
    })
  }

  it('lists a model whose page states an output video limit as video, on its own route', async () => {
    stub({
      [GEMINI_MODELS_INDEX_URL]: INDEX,
      'https://aistudio.google.com/docs/models/gemini-omni-flash.md': OMNI_PAGE,
    })

    const result = await geminiProvider.listModels({ GEMINI_API_KEY: KEY })

    expect(result.models).toEqual([
      expect.objectContaining({
        rawId: 'gemini-omni-1.2-flash',
        activity: 'video',
        schemaEndpointId: 'gemini-omni-1.2-flash',
      }),
    ])
  })

  it('lists genie-4 as video because the page states an output video stream (#697)', async () => {
    stub(
      {
        [GEMINI_MODELS_INDEX_URL]: `
{% table variant="model" %}
  * Model
  * Endpoint

  ---

  * [Genie 4](/docs/models/genie-4)
  * \`genie-4\`

  ---

  * [Gemini 2.5 Flash](/docs/models/gemini-2.5-flash)
  * \`gemini-2.5-flash\`
{% /table %}
`,
        'https://aistudio.google.com/docs/models/genie-4.md': GENIE_PAGE,
        'https://aistudio.google.com/docs/models/gemini-2.5-flash.md': `
## gemini-2.5-flash

| Model code | \`gemini-2.5-flash\` |
| Supported data types | **Inputs** Text **Output** Text |
`,
      },
      JSON.stringify({
        models: [
          {
            name: 'models/genie-4',
            displayName: 'Genie 4',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    )

    const result = await geminiProvider.listModels({ GEMINI_API_KEY: KEY })

    expect(result.models).toEqual([
      expect.objectContaining({
        rawId: 'genie-4',
        activity: 'video',
        schemaEndpointId: 'genie-4',
      }),
      expect.objectContaining({
        rawId: 'gemini-2.5-flash',
        activity: 'chat',
      }),
    ])
  })

  it('keeps the stored activity and route when the model page cannot be read', async () => {
    stub({ [GEMINI_MODELS_INDEX_URL]: INDEX })

    const result = await geminiProvider.listModels({ GEMINI_API_KEY: KEY })

    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({
      rawId: 'gemini-omni-1.2-flash',
      activity: null,
      schemaEndpointId: null,
      absent: {
        activity: 'unavailable',
        schemaEndpointId: 'unavailable',
        requestMap: 'unavailable',
      },
    })
  })
})
