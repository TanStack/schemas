import { afterEach, expect, it, vi } from 'vitest'
import { OPENCODE_GO_MODELS_URL } from './opencode-go-facts.ts'
import {
  classifyOpenCodeRoute,
  documentedRoutes,
  OPENCODE_ROUTE_DOCS_URL,
  openCodeRouteSpec,
} from './opencode-routes.ts'

/** inference.mdx excerpt (2026-10-21). */
const ZEN_DOCS = `# Inference API

## Endpoints

| API                     | Path                                                      |
| ----------------------- | --------------------------------------------------------- |
| OpenAI Chat Completions | \`/inference/openai/v1/chat/completions\`                   |
| OpenAI Responses        | \`/inference/openai/v1/responses\`                          |
| Anthropic Messages      | \`/inference/anthropic/v1/messages\`                        |
| Gemini                  | \`/inference/google/v1beta/models/<model>:generateContent\` |

### Gemini

\`\`\`bash
curl -X POST "https://opencode.ai/inference/google/v1beta/models/gemini-3.1-pro:generateContent"
\`\`\`
`

/** go.mdx excerpt (2026-10-21). */
const GO_DOCS = `# Go

## Endpoints

| Model  | Model ID | Endpoint                                                       | AI SDK Package              |
| ------ | -------- | -------------------------------------------------------------- | --------------------------- |
| GPT    | gpt      | \`https://opencode.ai/inference/go/openai/v1/responses\`         | \`@ai-sdk/openai\`            |
| Haiku  | haiku    | \`https://opencode.ai/inference/go/anthropic/v1/messages\`       | \`@ai-sdk/anthropic\`         |
| Gemini | gemini   | \`https://opencode.ai/inference/go/google/v1beta/models/gemini\` | \`@ai-sdk/google\`            |

## Privacy

\`https://opencode.ai/inference/go/openai/v1/chat/completions\`
`

/** Models list shaped like GET /inference/go/v1/models (2026-11-17). */
const GO_LISTING = {
  object: 'list',
  data: [
    {
      id: 'gpt',
      api: {
        responses: {
          base_url: 'https://opencode.ai/inference/go/openai/v1',
          sdk: { aisdk: '@ai-sdk/openai' },
        },
      },
    },
    {
      id: 'haiku',
      api: {
        messages: {
          base_url: 'https://opencode.ai/inference/go/anthropic/v1',
          sdk: { aisdk: '@ai-sdk/anthropic' },
        },
      },
    },
    {
      id: 'kimi',
      api: {
        'chat-completions': {
          base_url: 'https://opencode.ai/inference/go/openai/v1',
          sdk: {
            aisdk: '@ai-sdk/openai-compatible',
            opencodeai: '@opencode/ai/providers/openai-compatible',
          },
          compatibility: { reasoning_field: 'reasoning_content' },
        },
      },
      cost: { input: 1, output: 2 },
      limit: { context: 128000 },
      capabilities: { tools: true },
    },
  ],
}

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})
function serve(text: string) {
  globalThis.fetch = vi.fn(async () => new Response(text))
}
function fetched(): Array<string> {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
    String(call[0]),
  )
}

it('reads only the Endpoints table, with origins stripped', () => {
  expect([...documentedRoutes(GO_DOCS, 'go')]).toEqual([
    '/inference/go/openai/v1/responses',
    '/inference/go/anthropic/v1/messages',
    '/inference/go/google/v1beta/models/gemini',
  ])
  expect(() => documentedRoutes('# Inference', 'docs')).toThrow(
    'documents no endpoint paths',
  )
})
it('sources Zen protocol paths from the inference docs, with no schema bodies', async () => {
  serve(ZEN_DOCS)
  const result = await openCodeRouteSpec(
    [
      {
        schemaEndpointId: 'inference/openai/v1/chat/completions',
        activity: 'chat',
      },
      { schemaEndpointId: 'inference/openai/v1/responses', activity: 'chat' },
      { schemaEndpointId: 'inference/anthropic/v1/messages', activity: 'chat' },
      {
        schemaEndpointId:
          'inference/google/v1beta/models/gemini:generateContent',
        activity: 'chat',
      },
      { schemaEndpointId: null, activity: null },
    ],
    { url: 'https://models.dev/api.json', text: 'catalog fixture' },
    false,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/inference/openai/v1/chat/completions',
    '/inference/openai/v1/responses',
    '/inference/anthropic/v1/messages',
    '/inference/google/v1beta/models/gemini:generateContent',
  ])
  const operation =
    result.specs[0]?.paths?.['/inference/anthropic/v1/messages']?.post ?? {}
  expect(operation).not.toHaveProperty('requestBody')
  expect(operation.responses).toEqual({})
  expect(classifyOpenCodeRoute('/inference/v1/messages', operation)).toBe(
    'chat',
  )
  expect(classifyOpenCodeRoute('/inference/v1/messages', {})).toBeNull()
  expect(fetched()).toEqual([OPENCODE_ROUTE_DOCS_URL])
  const source = operation['x-modelschemas-method-source'] as {
    url: string
    hash: string
  }
  expect(source.url).toBe(OPENCODE_ROUTE_DOCS_URL)
  expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.sources.map((s) => s.url)).toEqual([
    'https://models.dev/api.json',
  ])
})
it('checks Go ids against routes from the models list api field', async () => {
  serve(JSON.stringify(GO_LISTING))
  const result = await openCodeRouteSpec(
    [
      {
        schemaEndpointId: 'inference/go/openai/v1/responses',
        activity: 'chat',
      },
      {
        schemaEndpointId: 'inference/go/anthropic/v1/messages',
        activity: 'chat',
      },
    ],
    { url: 'docs', text: 'docs' },
    true,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/inference/go/openai/v1/responses',
    '/inference/go/anthropic/v1/messages',
    '/inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent',
    '/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent',
  ])
  expect(fetched()).toEqual([OPENCODE_GO_MODELS_URL])
  const source = result.specs[0]?.paths?.['/inference/go/openai/v1/responses']
    ?.post?.['x-modelschemas-method-source'] as { url: string; hash: string }
  expect(source.url).toBe(OPENCODE_GO_MODELS_URL)
  expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
  const parameters = result.specs[0]?.paths?.[
    '/inference/go/openai/v1/responses'
  ]?.post?.parameters as Array<{ name: string; required: boolean }>
  expect(parameters.map((header) => header.name)).toEqual([
    'x-opencode-session',
    'User-Agent',
  ])
  expect(parameters.every((header) => header.required)).toBe(true)
})
it.each([
  ['inference/openai/v1/messages', false],
  ['inference/anthropic/v1/chat/completions', false],
  ['inference/go/openai/v1/chat/completions', false],
  ['inference/go/anthropic/v1/chat/completions', true],
  ['inference/go/google/v1beta/models/gemini:generateContent', true],
  ['inference/go/openai/v1/embeddings', true],
  ['inference/v1/messages', false],
  ['v1/chat/completions', true],
  ['v1/responses', true],
  ['v1/embeddings', true],
])('rejects %s, a route the docs do not list', async (id, go) => {
  serve(go ? JSON.stringify(GO_LISTING) : ZEN_DOCS)
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: id, activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      go,
    ),
  ).rejects.toThrow(`${go ? 'states' : 'documents'} no /${id} route`)
})
it('accepts the interactions route as route-only, with no request schema', async () => {
  serve(
    JSON.stringify({
      object: 'list',
      data: [
        ...GO_LISTING.data,
        {
          id: 'gemini-4-argon',
          api: {
            'generate-content': {
              base_url: 'https://opencode.ai/inference/go/google/v1beta',
              sdk: { opencodeai: '@opencode/ai/providers/google' },
            },
            interactions: {
              base_url: 'https://opencode.ai/inference/go/google/v1beta',
              sdk: {
                opencodeai: '@opencode/ai/providers/google/interactions',
              },
            },
          },
        },
      ],
    }),
  )
  const path = '/inference/go/google/v1beta/interactions'
  const result = await openCodeRouteSpec(
    [
      {
        schemaEndpointId: 'inference/go/openai/v1/responses',
        activity: 'chat',
      },
      {
        schemaEndpointId: 'inference/go/google/v1beta/interactions',
        activity: 'chat',
      },
    ],
    { url: 'docs', text: 'docs' },
    true,
  )
  const operation = result.specs[0]?.paths?.[path]?.post ?? {}
  expect(operation).not.toHaveProperty('requestBody')
  expect(operation.responses).toEqual({})
  expect(classifyOpenCodeRoute(path, operation)).toBe('chat')
  expect(result.specs[0]?.paths).not.toHaveProperty(
    '/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
  )
})
it('rejects a Go listing row with no api entry or an unknown protocol', async () => {
  serve(
    JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt', object: 'model' }],
    }),
  )
  await expect(
    openCodeRouteSpec(
      [
        {
          schemaEndpointId: 'inference/go/openai/v1/responses',
          activity: 'chat',
        },
      ],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow('opencode-go: gpt has no api entry')
  serve(
    JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'gpt',
          api: {
            speech: {
              base_url: 'https://opencode.ai/inference/go/openai/v1',
            },
          },
        },
      ],
    }),
  )
  await expect(
    openCodeRouteSpec(
      [
        {
          schemaEndpointId: 'inference/go/openai/v1/responses',
          activity: 'chat',
        },
      ],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow('opencode-go: gpt has unknown api protocol speech')
})
it('rejects a failed docs source', async () => {
  globalThis.fetch = vi.fn(async () => new Response('gone', { status: 404 }))
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: 'v1/messages', activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow()
})
