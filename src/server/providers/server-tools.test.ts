import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestUrl } from '#/lib/text.ts'

import { GROK_FILES_DOC_URL, grokProvider, parseGrokFileTool } from './grok.ts'
import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_MODEL_PAGE,
  openaiModelFacts,
} from './openai-model-docs.ts'
import { openrouterServerTools } from './openrouter.ts'
import {
  GROQ_BUILTIN_TOOLS_URL,
  groqModelServerTools,
  parseByteplusServerTools,
  parseGroqBuiltinTools,
  parseMistralPageTools,
} from './server-tools.ts'

const GROQ_TOOLS = `# Groq Built-In Tools

### GPT-OSS Models

**Models:**

* \`openai/gpt-oss-120b\`
* \`openai/gpt-oss-20b\`

**Available Tools:**

| Tool | Identifier |
| --- | --- |
| Browser Search | browser\\_search |
| Code Execution | code\\_interpreter |

### Something else

Llama stays on the models page and is not listed here.
`

const MISTRAL_TOOLS = `<html><body>
<h2>Supported tools</h2>
<p>This model accepts <code>web_search</code> and <code>code_interpreter</code>.</p>
<p>Client <code>function</code> tools are not hosted.</p>
</body></html>`

const BYTEPLUS_TOOLS = `# Image generation API

## Seedream 4.5

Model ID: \`seedream-4-5-251128\`

tools: [{"type": "web_search"}]

## Seedream 5.0 pro

Model ID: \`seedream-5-0-pro-260115\`

Sequential image generation, web search, and streaming output are not currently supported.
`

describe('server tools from docs (issue #123)', () => {
  it('reads Groq tool type ids only for models the built-in tools page names', () => {
    const tools = parseGroqBuiltinTools(GROQ_TOOLS)
    expect(tools.get('openai/gpt-oss-120b')).toEqual([
      'browser_search',
      'code_interpreter',
    ])
    expect(tools.get('openai/gpt-oss-20b')).toEqual([
      'browser_search',
      'code_interpreter',
    ])
    expect(tools.has('llama-3.3-70b-versatile')).toBe(false)
  })

  it('reads Mistral tool type ids from a model page and ignores a page that names none', () => {
    expect(parseMistralPageTools(MISTRAL_TOOLS)).toEqual([
      'web_search',
      'code_interpreter',
    ])
    expect(
      parseMistralPageTools(
        '<html><p>No tool section.</p><script>"web_search"</script></html>',
      ),
    ).toEqual([])
  })

  it('reads a BytePlus tool type only next to the model the section names', () => {
    const tools = parseByteplusServerTools(BYTEPLUS_TOOLS)
    expect(tools.get('seedream-4-5-251128')).toEqual(['web_search'])
    expect(tools.has('seedream-5-0-pro-260115')).toBe(false)
  })

  it('reads the files page tool id and its agentic models, or throws', () => {
    // docs.x.ai/developers/files.md as served on 2026-10-22, cut down.
    const files = [
      'Grok can search through documents you attach; the system automatically activates the `attachment_search` tool and transforms your request.',
      'When you attach files, the xAI API automatically activates the `attachment_search` [server-side tool](/developers/tools/overview).',
      '',
      '## Limitations',
      '',
      '* **Agentic models only**: Requires models that support agentic tool calling (e.g., `grok-4.20`, `grok-4.5`, `grok-4.6`, `grok-4.7`)',
    ].join('\n')
    expect(parseGrokFileTool(files)).toEqual({
      tool: 'attachment_search',
      models: ['grok-4.20', 'grok-4.5', 'grok-4.6', 'grok-4.7'],
    })
    expect(() =>
      parseGrokFileTool(files.replace(/^\* \*\*Agentic.*$/m, '')),
    ).toThrow('no Agentic models only list')
    expect(() =>
      parseGrokFileTool(
        files.replace('`attachment_search` [server', '`doc_search` [server'),
      ),
    ).toThrow('no single attachment tool id')
  })

  it('leaves OpenRouter null', () => {
    expect(
      openrouterServerTools({
        supported_parameters: ['tools', 'tool_choice', 'web_search'],
      }),
    ).toBeNull()
  })
})

/** Serve each URL's body; anything else is a 404. */
function serve(pages: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input)
      const body = pages[url]
      return Promise.resolve(
        body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(body, { status: 200 }),
      )
    }),
  )
}

const endpoints = (live: string, responses: string, realtime: string) => [
  '## Endpoints',
  '',
  '| Endpoint | Route | Support |',
  '| --- | --- | --- |',
  `| Live | \`v1/live/sessions\` | ${live} |`,
  '| Chat Completions | `v1/chat/completions` | Supported |',
  `| Responses | \`v1/responses\` | ${responses} |`,
  `| Realtime | \`v1/realtime\` | ${realtime} |`,
  '| Realtime translation | `v1/realtime/translations` | Not supported |',
  '| Realtime transcription | `v1/realtime/transcription_sessions` | Not supported |',
  '| Assistants | `v1/assistants` | Not supported |',
  '',
]

describe('a read page that names no tool is source-silent (#707)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Groq: a model the built-in tools page does not name states nothing', async () => {
    serve({ [GROQ_BUILTIN_TOOLS_URL]: GROQ_TOOLS })
    const tools = await groqModelServerTools()
    expect(tools('openai/gpt-oss-20b').serverTools).toEqual([
      'browser_search',
      'code_interpreter',
    ])
    // The page is not exhaustive (browser search names more models), so a
    // model it does not name gets no entry.
    expect(tools('allam-2-7b')).toEqual({})
  })

  it('OpenAI: silent only when no Responses, Realtime or Live route is supported', async () => {
    // developers.openai.com/api/docs/models/gpt-audio.md, 2026-11-21, cut down.
    const audio = [
      'Model ID: `gpt-audio`',
      '',
      '## Model details',
      '',
      '- Default snapshot: `gpt-audio-2025-08-28`',
      '- 128,000 context window',
      '',
      ...endpoints('Not supported', 'Not supported', 'Not supported'),
      '## Supported features',
      '',
      '- streaming',
      '- function_calling',
      '',
      '## Snapshots',
      '',
      '- `gpt-audio-2025-08-28` — Deprecated',
    ].join('\n')
    // developers.openai.com/api/docs/models/gpt-4o.md, 2026-11-21, cut down.
    const gpt4o = [
      'Model ID: `gpt-4o`',
      '',
      ...endpoints('Not supported', 'Supported', 'Not supported'),
      '## Supported tools',
      '',
      'Tools supported by this model when using the Responses API.',
      '',
      '- function_calling',
      '- web_search',
    ].join('\n')
    // developers.openai.com/api/docs/models/gpt-realtime-2.md and
    // gpt-live-1.md, 2026-11-21, cut down: no Supported tools section.
    const realtime = [
      'Model ID: `gpt-realtime-2`',
      '',
      ...endpoints('Not supported', 'Not supported', 'Supported'),
    ].join('\n')
    const live = [
      'Model ID: `gpt-live-1`',
      '',
      ...endpoints('Supported', 'Not supported', 'Not supported'),
    ].join('\n')
    // developers.openai.com/api/docs/models/gpt-4.md, 2026-11-21, cut down:
    // Responses supported, no Supported tools section.
    const gpt4 = [
      'Model ID: `gpt-4`',
      '',
      ...endpoints('Not supported', 'Supported', 'Not supported'),
    ].join('\n')
    serve({
      [OPENAI_MODELS_INDEX_URL]: [
        'gpt-audio',
        'gpt-4o',
        'gpt-realtime-2',
        'gpt-live-1',
        'gpt-4',
      ]
        .map((slug) => `[${slug}](/api/docs/models/${slug}.md)`)
        .join('\n'),
      [OPENAI_MODEL_PAGE('gpt-audio')]: audio,
      [OPENAI_MODEL_PAGE('gpt-4o')]: gpt4o,
      [OPENAI_MODEL_PAGE('gpt-realtime-2')]: realtime,
      [OPENAI_MODEL_PAGE('gpt-live-1')]: live,
      [OPENAI_MODEL_PAGE('gpt-4')]: gpt4,
    })
    const facts = await openaiModelFacts([
      'gpt-audio',
      'gpt-audio-2025-08-28',
      'gpt-4o',
      'gpt-5-search-api',
      'gpt-realtime-2',
      'gpt-live-1',
      'gpt-4',
    ])
    for (const id of ['gpt-realtime-2', 'gpt-live-1', 'gpt-4']) {
      expect(facts(id).serverTools).toBeNull()
      expect(facts(id).factSources?.serverTools).toBeUndefined()
    }
    for (const id of ['gpt-audio', 'gpt-audio-2025-08-28']) {
      expect(facts(id).serverTools).toBeNull()
      expect(facts(id).factSources?.serverTools).toEqual({
        derivation: 'source-silent',
        sourceUrl: OPENAI_MODEL_PAGE('gpt-audio'),
      })
    }
    expect(facts('gpt-4o').serverTools).toEqual(['web_search'])
    // No model page read: nothing is stated (the ledger covers it).
    expect(facts('gpt-5-search-api').factSources?.serverTools).toBeUndefined()
  })

  it('Grok: a model the "e.g." files list does not name stays unstated', async () => {
    // docs.x.ai/developers/files.md as served on 2026-11-21, cut down.
    const files = [
      'When you attach files to a chat message, the xAI API automatically activates the `attachment_search` [server-side tool](/developers/tools/overview).',
      '* **Agentic models only**: Requires models that support agentic tool calling (e.g., `grok-4.20`, `grok-4.5`, `grok-4.6`, `grok-4.7`)',
    ].join('\n')
    const api = {
      'https://api.x.ai/v1/models': JSON.stringify({
        data: [{ id: 'grok-4.7' }, { id: 'grok-4.3' }],
      }),
      'https://api.x.ai/v1/language-models': JSON.stringify({
        models: [{ id: 'grok-4.7' }, { id: 'grok-4.3' }],
      }),
      'https://api.x.ai/v1/image-generation-models': '{"models":[]}',
      'https://api.x.ai/v1/video-generation-models': '{"models":[]}',
      'https://docs.x.ai/docs/models.md':
        '| Model | Context |\n| --- | --- |\n| grok-4.7 | 500k |\n| grok-4.3 | 1M |',
    }
    const env = { XAI_API_KEY: 'test' }
    serve({ ...api, [GROK_FILES_DOC_URL]: files })
    const read = await grokProvider.listModels(env)
    const byId = new Map(read.models.map((m) => [m.rawId, m]))
    expect(byId.get('grok-4.7')?.serverTools).toEqual(['attachment_search'])
    expect(byId.get('grok-4.3')?.serverTools).toBeUndefined()
    // The bullet is "e.g.": not being named states nothing.
    expect(byId.get('grok-4.3')?.factSources?.serverTools).toBeUndefined()

    serve(api)
    const failed = await grokProvider.listModels(env)
    const grok43 = failed.models.find((m) => m.rawId === 'grok-4.3')
    expect(grok43?.absent?.serverTools).toBe('unavailable')
    expect(grok43?.factSources?.serverTools).toBeUndefined()
  })
})
