/**
 * Hosted MCP on the Realtime API (#707). The "Realtime with tools" guide
 * documents `type: "mcp"` session tools but keeps no model list; its code
 * samples pair a literal `model` with an `mcp` tool. Only those models are
 * bound: a realtime model the samples do not name states nothing.
 */
import { tagDocsFacts } from './fact-sources.ts'
import type { ModelFacts, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource } from './types.ts'
import type { Fetcher } from './us-egress.ts'

export const OPENAI_REALTIME_MCP_URL =
  'https://developers.openai.com/api/docs/guides/realtime-mcp.md'

const MCP_TOOL = /\btools"?\s*[:=]\s*\[\s*\{\s*"?type"?\s*:\s*"mcp"/
const MODEL = /\bmodel"?\s*[:=]\s*"(gpt-[a-z0-9.-]+)"/g

/**
 * Model ids a fenced sample puts beside a `tools` entry of type `mcp`.
 * A guide whose samples pair none throws, so reworded samples never read
 * as "no model".
 */
export function parseOpenAiRealtimeMcp(markdown: string): Array<string> {
  const ids = new Set<string>()
  for (const block of markdown.match(/```[\s\S]*?```/g) ?? []) {
    if (!MCP_TOOL.test(block)) continue
    for (const match of block.matchAll(MODEL)) {
      if (match[1]) ids.add(match[1])
    }
  }
  if (ids.size === 0) {
    throw new Error(
      'openai realtime mcp guide: no sample pairs a model with mcp',
    )
  }
  return [...ids]
}

export async function openaiRealtimeMcp(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
  fetcher: Fetcher = fetch,
): Promise<{ rawIds: Array<string>; hash: string }> {
  return cached(kv, OPENAI_REALTIME_MCP_URL, async () => {
    const markdown = await fetchText(
      OPENAI_REALTIME_MCP_URL,
      undefined,
      fetcher,
    )
    return {
      rawIds: parseOpenAiRealtimeMcp(markdown),
      hash: await sha256Text(markdown),
    }
  })
}

/** Add `mcp` to a model's page-read tools, sourced to the guide. */
export function withRealtimeMcp<
  T extends Pick<ModelFacts, 'serverTools' | 'factSources'>,
>(facts: T, hash: string): T {
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
        ...tagDocsFacts({ serverTools: ['mcp'] }, OPENAI_REALTIME_MCP_URL, hash)
          .serverTools,
      },
    },
  }
}
