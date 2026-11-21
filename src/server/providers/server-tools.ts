/**
 * Provider-hosted tool type ids (issue #123). A page that does not name a
 * type id for a model contributes nothing. Grok (`grok.ts`) and BytePlus
 * MCP (`byteplus-tools.ts`) are read beside their adapters; OpenRouter ids
 * are router-level and are not parsed.
 */
import { serverToolsSilent, tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  markdownTableRows,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import type { DocsRun, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const GROQ_BUILTIN_TOOLS_URL =
  'https://console.groq.com/docs/tool-use/built-in-tools.md'

type HostedFacts = Pick<ModelInfo, 'serverTools' | 'factSources' | 'absent'>

function unescapeDocs(markdown: string): string {
  return markdown.replace(/\\([_`])/g, '$1')
}

/**
 * Built-in tools page: each `###` section names model ids in bullets and
 * tool type ids in an Identifier column. Sections that name neither stay
 * out of the map.
 */
export function parseGroqBuiltinTools(
  markdown: string,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  const text = unescapeDocs(markdown)
  for (const section of text.split(/\n### /).slice(1)) {
    const rows = markdownTableRows(section)
    const header = rows.find((row) =>
      row.some((cell) => /^identifier$/i.test(cell)),
    )
    const column = header?.findIndex((cell) => /^identifier$/i.test(cell)) ?? -1
    if (!header || column < 0) continue
    const tools = [
      ...new Set(
        rows
          .filter((row) => row !== header)
          .flatMap((row) => {
            const id = row[column]?.trim() ?? ''
            return /^[a-z][a-z0-9_]*$/.test(id) ? [id] : []
          }),
      ),
    ]
    if (tools.length === 0) continue
    const toolSet = new Set(tools)
    for (const match of section.matchAll(/^[*+-]\s+`([^`]+)`/gm)) {
      const id = match[1]?.trim() ?? ''
      if (id.length === 0 || toolSet.has(id) || id.startsWith('http')) continue
      out.set(id, tools)
    }
  }
  return out
}

/**
 * One page per hosted tool type Groq accepts: browser search and code
 * execution (the two the built-in tools page says `tools` takes) and remote
 * MCP. Each page's "Supported Models" table lists every model that takes
 * its tool (#707).
 */
export const GROQ_TOOL_PAGE_URLS = [
  'https://console.groq.com/docs/browser-search.md',
  'https://console.groq.com/docs/code-execution.md',
  'https://console.groq.com/docs/tool-use/remote-mcp.md',
] as const

/**
 * A Groq tool page: the Model ID column of its `## Supported Models` table,
 * and the one tool type id its request examples put in `tools`. Any other
 * shape throws, so changed wording never reads as "no model".
 */
export function parseGroqToolPage(markdown: string): {
  tool: string
  models: Array<string>
} {
  const text = unescapeDocs(markdown)
  const section = text
    .split(/^## /m)
    .find((part) => part.startsWith('[Supported Models'))
  const [header, ...rows] = section ? markdownTableRows(section) : []
  if (!header || !/^model id$/i.test(header[0] ?? '')) {
    throw new Error('groq tool page: no Supported Models table')
  }
  const models = rows.flatMap((row) => {
    const id = row[0]?.trim() ?? ''
    return /^[a-z0-9][\w./-]*$/i.test(id) ? [id] : []
  })
  const tools = new Set(
    [
      ...text.matchAll(
        /\btools"?\s*[:=]\s*\[\s*\{\s*"?type"?\s*:\s*["']([a-z][a-z0-9_]*)["']/g,
      ),
    ].flatMap((match) => (match[1] ? [match[1]] : [])),
  )
  const [tool, ...more] = tools
  if (models.length === 0 || !tool || more.length > 0) {
    throw new Error(
      `groq tool page: ${models.length} models, tools ${[...tools].join(',') || 'none'}`,
    )
  }
  return { tool, models }
}

type GroqToolDoc = { tools: Record<string, Array<string>>; hash: string }

async function loadGroqBuiltinTools(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<GroqToolDoc> {
  return cached(kv, GROQ_BUILTIN_TOOLS_URL, async () => {
    const markdown = await fetchText(GROQ_BUILTIN_TOOLS_URL)
    const parsed = parseGroqBuiltinTools(markdown)
    assertParsed(parsed, 'groq built-in tools')
    return {
      tools: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
    }
  })
}

async function loadGroqToolPage(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
  url: string,
): Promise<GroqToolDoc> {
  return cached(kv, url, async () => {
    const markdown = await fetchText(url)
    const { tool, models } = parseGroqToolPage(markdown)
    return {
      tools: Object.fromEntries(models.map((id) => [id, [tool]])),
      hash: await sha256Text(markdown),
    }
  })
}

/**
 * Lookup from the built-in tools page and the three tool pages, each loaded
 * through `tryDocs` under its own cache key. Any page failing marks every
 * row `unavailable`, so a partial list is never stored. With all four read,
 * a model none of them names takes no hosted tool: source-silent (#707).
 */
export async function groqModelServerTools(
  kv: KVNamespace | undefined,
  docs: DocsRun,
): Promise<(rawId: string) => HostedFacts> {
  const urls = [GROQ_BUILTIN_TOOLS_URL, ...GROQ_TOOL_PAGE_URLS]
  const loaded = await Promise.all(
    urls.map((url) =>
      tryDocs(docs, url, (cached) =>
        url === GROQ_BUILTIN_TOOLS_URL
          ? loadGroqBuiltinTools(kv, cached)
          : loadGroqToolPage(kv, cached, url),
      ),
    ),
  )
  const pages = urls.flatMap((url, index) => {
    const doc = loaded[index]
    return doc ? [{ url, doc }] : []
  })
  if (pages.length < urls.length) return () => unavailable('serverTools')
  return (rawId) => {
    const hits = pages.flatMap(({ url, doc }) => {
      const tools = doc.tools[rawId]
      return tools && tools.length > 0 ? [{ url, hash: doc.hash, tools }] : []
    })
    if (hits.length === 0) {
      return {
        factSources: { serverTools: serverToolsSilent(GROQ_BUILTIN_TOOLS_URL) },
      }
    }
    return {
      serverTools: [...new Set(hits.flatMap((hit) => hit.tools))],
      factSources: {
        serverTools: Object.fromEntries(
          hits.flatMap((hit) =>
            Object.entries(
              tagDocsFacts({ serverTools: hit.tools }, hit.url, hit.hash)
                .serverTools ?? {},
            ),
          ),
        ),
      },
    }
  }
}

const CLIENT_TOOL = 'function'

/**
 * Tool type ids a Mistral model page names under Supported tools or
 * Built-in tools. `function` is a client tool. Nav and scripts are not
 * the model page.
 */
export function parseMistralPageTools(html: string): Array<string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<code>([^<]+)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, ' ')
  const start = text.search(/supported tools|built-in tools/i)
  if (start < 0) return []
  const section = text.slice(start, start + 2500)
  const ids = [
    ...section.matchAll(/`([a-z][a-z0-9_]*)`/g),
    ...section.matchAll(/"type"\s*:\s*"([a-z][a-z0-9_]*)"/g),
  ].flatMap((match) => {
    const id = match[1] ?? ''
    return id.length > 0 && id !== CLIENT_TOOL ? [id] : []
  })
  return [...new Set(ids)]
}

/**
 * Ark docs: a `##` section that names catalog ids and a `tools` entry's
 * `type` assigns those ids. A section that only says a capability is not
 * supported does not.
 */
export function parseByteplusServerTools(
  doc: string,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  const text = doc.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  for (const section of text.split(/\n## /).slice(1)) {
    if (
      /not currently supported/i.test(section) &&
      !/"type"\s*:/.test(section)
    ) {
      continue
    }
    const tools = [
      ...new Set(
        [
          ...section.matchAll(
            /tools[\s\S]{0,400}?"type"\s*:\s*"([a-z][a-z0-9_]*)"/g,
          ),
        ].flatMap((match) => (match[1] ? [match[1]] : [])),
      ),
    ]
    if (tools.length === 0) continue
    for (const match of section.matchAll(
      /`([a-z0-9][a-z0-9.-]*\d[a-z0-9.-]*)`/g,
    )) {
      const id = match[1]
      if (id) out.set(id, tools)
    }
  }
  return out
}
