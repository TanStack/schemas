/**
 * Hosted MCP on the Realtime API (#707). The "Realtime with tools" guide
 * documents `type: "mcp"` session tools but keeps no model list; its code
 * samples pair a literal `model` with an `mcp` tool. Only those models are
 * bound, and the binding is example-derived: its source path names the
 * sample's heading. The guide is not a complete list, so a realtime model
 * the samples do not name keeps its stored tools.
 */
import type { ModelFacts, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource } from './types.ts'
import type { Fetcher } from './us-egress.ts'

export const OPENAI_REALTIME_MCP_URL =
  'https://developers.openai.com/api/docs/guides/realtime-mcp.md'

// Matches the TypeScript and Python samples' `tools: [{ type: "mcp"` shape;
// the Go, Java, C# and Ruby samples spell it differently and are not read.
const MCP_TOOL = /\btools"?\s*[:=]\s*\[\s*\{\s*"?type"?\s*:\s*"mcp"/
const MODEL = /\bmodel"?\s*[:=]\s*"(gpt-[a-z0-9.-]+)"/g

export interface RealtimeMcpSample {
  model: string
  /** The `##`/`###` heading the sample sits under. */
  heading: string
  lang: string
}

/**
 * Each fenced sample that puts one literal model beside a `tools` entry of
 * type `mcp`. A sample naming two models throws (one may be a transcription
 * model), and so does a guide whose samples pair none.
 */
export function parseOpenAiRealtimeMcp(
  markdown: string,
): Array<RealtimeMcpSample> {
  const out: Array<RealtimeMcpSample> = []
  let heading = ''
  let fence: { lang: string; lines: Array<string> } | null = null
  for (const line of markdown.split('\n')) {
    if (fence) {
      if (!line.startsWith('```')) {
        fence.lines.push(line)
        continue
      }
      const block = fence.lines.join('\n')
      if (MCP_TOOL.test(block)) {
        const models = [
          ...new Set([...block.matchAll(MODEL)].map((match) => match[1])),
        ].filter((id): id is string => id !== undefined)
        if (models.length > 1) {
          throw new Error(
            `openai realtime mcp guide: one mcp sample names ${models.join(', ')}`,
          )
        }
        if (models[0]) out.push({ model: models[0], heading, lang: fence.lang })
      }
      fence = null
    } else if (line.startsWith('```')) {
      fence = { lang: line.slice(3).trim(), lines: [] }
    } else {
      const title = /^#{2,3} (.+)$/.exec(line)?.[1]
      if (title) heading = title.trim()
    }
  }
  if (out.length === 0) {
    throw new Error(
      'openai realtime mcp guide: no sample pairs a model with mcp',
    )
  }
  return out
}

export async function openaiRealtimeMcp(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
  fetcher: Fetcher = fetch,
): Promise<{ headings: Record<string, string>; hash: string }> {
  return cached(kv, OPENAI_REALTIME_MCP_URL, async () => {
    const markdown = await fetchText(
      OPENAI_REALTIME_MCP_URL,
      undefined,
      fetcher,
    )
    const headings: Record<string, string> = {}
    for (const sample of parseOpenAiRealtimeMcp(markdown)) {
      headings[sample.model] ??= sample.heading
    }
    return { headings, hash: await sha256Text(markdown) }
  })
}

/** Add `mcp` to a model's page-read tools, sourced to the guide sample. */
export function withRealtimeMcp<
  T extends Pick<ModelFacts, 'serverTools' | 'factSources'>,
>(facts: T, heading: string, hash: string): T {
  // A page that said "no tools" is overruled by the guide naming this model.
  const prior = facts.factSources?.serverTools
  const sources: Record<string, FactSource> =
    prior && prior.derivation !== 'source-silent'
      ? (prior as Record<string, FactSource>)
      : {}
  return {
    ...facts,
    serverTools: [...new Set([...(facts.serverTools ?? []), 'mcp'])],
    factSources: {
      ...facts.factSources,
      serverTools: {
        ...sources,
        mcp: {
          derivation: 'docs-derived',
          sourceUrl: OPENAI_REALTIME_MCP_URL,
          sourceHash: hash,
          path: `${heading} (sample)`,
        },
      },
    },
  }
}
