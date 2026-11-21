import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  attachGeminiPublishedFacts,
  parseAutomaticRoutes,
  parseChangelogAliases,
  parseGeminiReleaseDates,
  htmlTables,
  parseGemmaCardFacts,
  parseGemmaModalities,
} from './gemini-bindings.ts'
import type { GeminiPublishedBindings } from './gemini-bindings.ts'
import type {
  FactAbsence,
  ModelFact,
  ModelFactSources,
  ModelInfo,
} from './types.ts'

const CHANGELOG = `This page documents updates to the Gemini API.

## May 19, 2026

- Released \`gemini-3.5-flash\`, the generally available version.
  This is now the model behind \`gemini-flash-latest\`.

## March 9, 2026

- The \`gemini-3-pro-preview\` now points to \`gemini-3.1-pro-preview\`.

## January 21, 2026

- Changed the \`latest\` aliases:

  - \`gemini-pro-latest\` switched to \`gemini-3-pro-preview\`
  - \`gemini-flash-latest\` switched to \`gemini-3-flash-preview\`

- Released \`gemini-2.0-flash-thinking-exp-01-21\`, the latest preview version of the model behind the [Gemini 2.0 Flash Thinking Model](https://example.com).
`

const GEMMA = `Gemma 4 models are multimodal, handling text and image input
and generating text output.

| Property | E2B | E4B | 12B Unified | 31B Dense |
|---|---|---|---|---|
| **Supported Modalities** | Text, Image, Audio | Text, Image, Audio | Text, Image, Audio | Text, Image |

| Property | 26B A4B MoE |
|---|---|
| **Supported Modalities** | Text, Image |
`

interface Listed {
  rawId: string
  modalities: { input: Array<string>; output: Array<string> } | null
  aliases?: Array<string> | null
  aliasOf?: string | null
  pricing?: unknown
  factSources?: ModelFactSources
  absent?: Partial<Record<ModelFact, FactAbsence>>
}

function bindings(
  over: Partial<GeminiPublishedBindings> = {},
): GeminiPublishedBindings {
  return {
    aliases: {},
    changelog: {
      url: 'https://aistudio.google.com/docs/changelog.md',
      hash: 'changelog',
    },
    gemma: {},
    gemmaCard: null,
    gemmaSource: {
      url: 'https://ai.google.dev/gemma/docs/core/model_card_4',
      hash: 'gemma',
    },
    docsFailures: { failed: 0, skipped: 0, first: [] },
    ...over,
  }
}

describe('gemini published bindings', () => {
  it('routes only an automatic-routing sentence, one id per row', () => {
    const routes = parseAutomaticRoutes(`
| \`gemini-3.7-flash\` | August 13, 2026 | N/A | \`gemini-3.8-flash\` (automatically routes API requests to \`gemini-3.8-flash\`) |
| \`gemini-3.5-flash\` | May 19, 2026 | N/A | \`gemini-3.6-flash\` (automatically routed to \`gemini-3.6-flash\`) |
| \`gemini-omni-flash-preview\` | June 30, 2026 | October 22, 2026 | \`gemini-omni-1.1-flash\` |

Requests to \`gemini-2.0-flash\` are shut down. The recommended replacement is \`gemini-3.6-flash\`.
`)
    expect([...routes]).toEqual([
      ['gemini-3.7-flash', 'gemini-3.8-flash'],
      ['gemini-3.5-flash', 'gemini-3.6-flash'],
    ])
  })

  it('reads a Release date column and skips a parenthetical id', () => {
    const dates = parseGeminiReleaseDates(`
{% table %}
  * Model
  * Release date
  * Shutdown date
  ---
  * \`gemini-4-argon\`
  * October 13, 2026
  * No shutdown date announced
  ---
  * \`gemini-3.8-flash\` (\`gemini-3.7-flash\` is routed)
  * September 2, 2026
  * No shutdown date announced
  ---
  * \`gemini-3.5-transcribe\`
  * August 2026
  * No shutdown date announced
  ---
  * \`embedding-gecko-001\`
  *
  * No shutdown date announced
{% /table %}
`)
    expect([...dates]).toEqual([
      ['gemini-4-argon', '2026-10-13'],
      ['gemini-3.8-flash', '2026-09-02'],
      ['gemini-3.5-transcribe', '2026-08-01'],
    ])
  })

  it('keeps the newest changelog alias and ignores a later hop', () => {
    const aliases = parseChangelogAliases(CHANGELOG)
    expect(aliases.get('gemini-flash-latest')).toBe('gemini-3.5-flash')
    expect(aliases.get('gemini-pro-latest')).toBe('gemini-3-pro-preview')
    expect(aliases.has('gemini-flash-lite-latest')).toBe(false)
    expect(aliases.has('gemini-3-pro-preview')).toBe(false)
    expect(aliases.has('gemini-2.0-flash-thinking-exp-01-21')).toBe(false)
  })

  it('refuses a changelog that is not the Gemini API changelog', () => {
    expect(() => parseChangelogAliases('# Models\n')).toThrow(
      /not the Gemini API changelog/,
    )
  })

  it('reads Gemma size columns and does not treat E2B as 2B', () => {
    const modalities = parseGemmaModalities(GEMMA)
    expect(modalities.get('gemma-4-31b-it')).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(modalities.get('gemma-4-26b-a4b-it')).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(modalities.get('gemma-4-12b-it')?.input).toEqual([
      'text',
      'image',
      'audio',
    ])
    expect(modalities.has('gemma-4-2b-it')).toBe(false)
    expect(modalities.has('gemma-4-4b-it')).toBe(false)
  })

  it('reads the Gemma card served as HTML (#568)', () => {
    const html = `<p>Gemma 4 models, generating text output.</p>
<table><thead><tr><th style="text-align: left">Property</th><th>E2B</th><th>31B Dense</th></tr></thead>
<tbody><tr><td><strong>Supported Modalities</strong></td><td>Text, Image, Audio</td><td>Text, Image</td></tr></tbody></table>`
    const modalities = parseGemmaModalities(htmlTables(html))
    expect([...modalities]).toEqual([
      ['gemma-4-31b-it', { input: ['text', 'image'], output: ['text'] }],
    ])
  })

  it('returns no Gemma modalities when the card has no such row', () => {
    expect(
      parseGemmaModalities('Gemma 4 models, generating text output.\n').size,
    ).toBe(0)
  })

  it('throws when a Gemma modality cell is not a medium', () => {
    expect(() =>
      parseGemmaModalities(`generating text output
| Property | 31B Dense |
| **Supported Modalities** | Text, Hologram |
`),
    ).toThrow(/unknown modality/)
  })

  it('copies alias modalities and records the alias on the dated row', () => {
    const modalities = {
      input: ['text', 'image', 'audio', 'video', 'file'],
      output: ['text'],
    }
    const models = attachGeminiPublishedFacts<Listed>(
      [
        {
          rawId: 'gemini-3.5-flash',
          modalities,
          factSources: {
            modalities: {
              derivation: 'docs-derived' as const,
              sourceUrl:
                'https://aistudio.google.com/docs/models/gemini-3.5-flash.md',
              sourceHash: 'page',
              path: 'Supported data types',
            },
          },
        },
        { rawId: 'gemini-flash-latest', modalities: null },
        {
          rawId: 'gemini-3-pro-preview',
          modalities: { input: ['text'], output: ['text'] },
          factSources: {
            modalities: {
              derivation: 'docs-derived' as const,
              sourceUrl:
                'https://aistudio.google.com/docs/models/gemini-3-pro-preview.md',
              path: 'Supported data types',
            },
          },
        },
        { rawId: 'gemini-pro-latest', modalities: null },
        { rawId: 'gemini-flash-lite-latest', modalities: null },
        { rawId: 'gemma-4-31b-it', modalities: null },
      ],
      bindings({
        aliases: {
          'gemini-flash-latest': 'gemini-3.5-flash',
          'gemini-pro-latest': 'gemini-3-pro-preview',
        },
        gemma: {
          'gemma-4-31b-it': { input: ['text', 'image'], output: ['text'] },
        },
      }),
    )
    const flash = models.find((model) => model.rawId === 'gemini-flash-latest')
    expect(flash?.modalities).toEqual(modalities)
    expect(flash?.factSources?.modalities).toEqual({
      derivation: 'docs-derived',
      sourceUrl: 'https://aistudio.google.com/docs/models/gemini-3.5-flash.md',
      sourceHash: 'page',
      path: 'Supported data types; alias of gemini-3.5-flash',
    })
    const target = models.find((model) => model.rawId === 'gemini-3.5-flash')
    expect(target?.aliases).toEqual(['gemini-flash-latest'])
    expect(target?.factSources?.aliases?.path).toBe('latest alias')
    // Issue #709: each named alias points at its stated target, listed or
    // not; a `-latest` row the changelog names nothing for says so.
    expect(flash?.aliasOf).toBe('gemini-3.5-flash')
    expect(flash?.factSources?.aliasOf).toEqual({
      derivation: 'docs-derived',
      sourceUrl: 'https://aistudio.google.com/docs/changelog.md',
      sourceHash: 'changelog',
      path: 'latest alias',
    })
    expect(
      models.find((model) => model.rawId === 'gemini-pro-latest')?.aliasOf,
    ).toBe('gemini-3-pro-preview')
    const lite = models.find(
      (model) => model.rawId === 'gemini-flash-lite-latest',
    )
    expect(lite?.aliasOf).toBeNull()
    expect(lite?.factSources?.aliasOf?.path).toBe('unstated')
    expect(
      models.find((model) => model.rawId === 'gemma-4-31b-it')?.factSources
        ?.aliasOf,
    ).toBeUndefined()
    expect(
      models.find((model) => model.rawId === 'gemini-pro-latest')?.modalities,
    ).toEqual({ input: ['text'], output: ['text'] })
    expect(
      models.find((model) => model.rawId === 'gemini-flash-lite-latest')
        ?.modalities,
    ).toBeNull()
    expect(
      models.find((model) => model.rawId === 'gemma-4-31b-it')?.modalities,
    ).toEqual({ input: ['text', 'image'], output: ['text'] })
  })

  it('copies an alias price from the changelog target (#661)', () => {
    const models = attachGeminiPublishedFacts<Listed>(
      [
        {
          rawId: 'gemini-3-flash-preview',
          modalities: null,
          pricing: { price: 1 },
          factSources: {
            pricing: {
              derivation: 'docs-derived',
              sourceUrl: 'https://aistudio.google.com/docs/pricing.md',
              sourceHash: 'pricing-page',
              path: 'Input price',
            },
          },
        },
        {
          rawId: 'gemini-flash-latest',
          modalities: null,
          pricing: null,
          absent: { pricing: 'cleared' },
        },
      ],
      bindings({
        aliases: { 'gemini-flash-latest': 'gemini-3-flash-preview' },
      }),
    )
    const alias = models.find((model) => model.rawId === 'gemini-flash-latest')
    expect(alias?.pricing).toEqual({ price: 1 })
    expect(alias?.absent).toBeUndefined()
    expect(alias?.factSources?.pricing).toEqual({
      derivation: 'docs-derived',
      sourceUrl: 'https://aistudio.google.com/docs/pricing.md',
      sourceHash: 'pricing-page',
      path: 'Input price; alias of gemini-3-flash-preview',
    })
  })

  it('keeps stored modalities when the changelog or Gemma card fails', () => {
    const models = attachGeminiPublishedFacts<Listed>(
      [
        { rawId: 'gemini-flash-latest', modalities: null },
        {
          rawId: 'gemini-3.5-flash',
          modalities: { input: ['text'], output: ['text'] },
        },
        { rawId: 'gemma-4-31b-it', modalities: null },
        {
          rawId: 'gemma-4-26b-a4b-it',
          modalities: { input: ['text'], output: ['text'] },
        },
      ],
      bindings({ aliases: null, gemma: null }),
    )
    expect(
      models.find((model) => model.rawId === 'gemini-flash-latest')?.absent
        ?.modalities,
    ).toBe('unavailable')
    // Every alias link is the changelog's: a failed read keeps them all.
    expect(
      models.find((model) => model.rawId === 'gemini-flash-latest')?.absent,
    ).toEqual({
      modalities: 'unavailable',
      aliases: 'unavailable',
      aliasOf: 'unavailable',
      maker: 'unavailable',
      openWeights: 'unavailable',
      // Its tools are the changelog target's too (#707).
      serverTools: 'unavailable',
    })
    expect(
      models.find((model) => model.rawId === 'gemini-3.5-flash')?.absent,
    ).toEqual({
      aliases: 'unavailable',
      maker: 'unavailable',
      openWeights: 'unavailable',
    })
    expect(
      models.find((model) => model.rawId === 'gemma-4-31b-it')?.absent
        ?.modalities,
    ).toBe('unavailable')
    expect(
      models.find((model) => model.rawId === 'gemma-4-26b-a4b-it')?.modalities,
    ).toEqual({ input: ['text'], output: ['text'] })
  })
  it('copies alias server tools from the changelog target, or keeps them when it fails (#707)', () => {
    type Row = Pick<
      ModelInfo,
      'rawId' | 'modalities' | 'serverTools' | 'factSources' | 'absent'
    >
    const page =
      'https://aistudio.google.com/docs/models/gemini-3-flash-preview.md'
    const rows: Array<Row> = [
      {
        rawId: 'gemini-3-flash-preview',
        modalities: null,
        serverTools: ['googleSearch'],
        factSources: {
          serverTools: {
            googleSearch: {
              derivation: 'docs-derived',
              sourceUrl: page,
              path: 'Capabilities',
            },
          },
        },
      },
      { rawId: 'gemini-flash-latest', modalities: null, serverTools: null },
    ]
    const alias = attachGeminiPublishedFacts<Row>(
      rows,
      bindings({
        aliases: { 'gemini-flash-latest': 'gemini-3-flash-preview' },
      }),
    ).find((model) => model.rawId === 'gemini-flash-latest')
    expect(alias?.serverTools).toEqual(['googleSearch'])
    expect(alias?.factSources?.serverTools).toEqual({
      googleSearch: {
        derivation: 'docs-derived',
        sourceUrl: page,
        path: 'Capabilities; alias of gemini-3-flash-preview',
      },
    })

    const failed = attachGeminiPublishedFacts<Row>(
      rows,
      bindings({ aliases: null }),
    ).find((model) => model.rawId === 'gemini-flash-latest')
    expect(failed?.absent?.serverTools).toBe('unavailable')

    // The target's page failed: the alias keeps its stored tools as well.
    const unread = attachGeminiPublishedFacts<Row>(
      [
        {
          rawId: 'gemini-3-flash-preview',
          modalities: null,
          serverTools: null,
          absent: { serverTools: 'unavailable' },
        },
        { rawId: 'gemini-flash-latest', modalities: null, serverTools: null },
      ],
      bindings({
        aliases: { 'gemini-flash-latest': 'gemini-3-flash-preview' },
      }),
    ).find((model) => model.rawId === 'gemini-flash-latest')
    expect(unread?.absent?.serverTools).toBe('unavailable')
    expect(unread?.factSources?.serverTools).toBeUndefined()
  })
})

describe('gemma maker and weights (#710)', () => {
  const HEADER = readFileSync(
    new URL('./fixtures/gemma-4-card-header.html.txt', import.meta.url),
    'utf8',
  )
  const card = parseGemmaCardFacts(HEADER)
  const rows: Array<Listed> = [
    { rawId: 'gemma-4-31b-it', modalities: null },
    { rawId: 'gemini-3.5-flash', modalities: null },
  ]

  it('reads Authors, the open-weights sentence and the Hugging Face link (2026-11-21)', () => {
    expect(card).toEqual({
      maker: 'Google DeepMind',
      openWeights: true,
      weightsUrl: 'https://huggingface.co/collections/google/gemma-4',
    })
    expect(parseGemmaCardFacts('<p>Gemma 4</p>')).toEqual({
      maker: null,
      openWeights: null,
      weightsUrl: null,
    })
  })

  it('binds them only to the sizes the card table binds', () => {
    const [gemma, gemini] = attachGeminiPublishedFacts(
      rows,
      bindings({
        gemma: { 'gemma-4-31b-it': { input: ['text'], output: ['text'] } },
        gemmaCard: card,
      }),
    )
    expect(gemma).toMatchObject({
      maker: 'Google DeepMind',
      openWeights: true,
      weightsUrl: 'https://huggingface.co/collections/google/gemma-4',
      factSources: {
        maker: { path: 'Authors' },
        openWeights: { path: 'open-weights models; Hugging Face' },
      },
    })
    expect(gemini).toEqual(rows[1])
  })

  it('keeps the stored facts when the card could not be read', () => {
    const [gemma] = attachGeminiPublishedFacts(
      rows,
      bindings({ gemma: null, gemmaCard: null }),
    )
    expect(gemma?.absent).toMatchObject({
      maker: 'unavailable',
      openWeights: 'unavailable',
    })
  })
})
