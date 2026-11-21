import { blankRequestMap } from '../request-map.ts'
import type { ChatRequestMap } from '../request-map.ts'
import { reasoningViolation } from '../types.ts'
import type { FactSource, ModelInfo } from '../types.ts'
import type { ChatCompletionsProbe } from './chat-completions.ts'
import {
  OPENCODE_GO_PROBE_SOURCE,
  records as opencodeGo,
} from './opencode-go.ts'
import { probeIsStale } from './types.ts'
import type { ProbeRecord, ServedProbeFact } from './types.ts'

const SOURCE: Record<string, string> = {
  'opencode-go': OPENCODE_GO_PROBE_SOURCE,
}

/** LEGACY hand-written route records (see `ProbeRecord`). */
export const probeRecords: Array<ProbeRecord> = [...opencodeGo]

/**
 * Secret name assumed for the LLM Gateway key (not final). The probe reads
 * it from here only; llmgateway stays a disabled gateway either way.
 */
export const LLMGATEWAY_KEY_SECRET = 'LLMGATEWAY_API_KEY'

/**
 * Providers on the generic `chat/completions` probe (issue #717). `url` is
 * the adapter's API server plus the chat route its rows bind
 * (`generationEndpointId`); the probe applies only to rows bound to
 * exactly `route`. Set `mandatoryRule` only for a provider whose
 * `reasoning_effort` level list is per model and is the model's only
 * reasoning control. A missing key is a logged skip.
 *
 * Not here: perplexity (its rows bind `v1/agent`, not chat/completions),
 * opencode-go (the Worker holds no key). Gateways and resellers
 * (openrouter, vercel, huggingface, lovable, opencode, cloudflare AI
 * Gateway) are not listed; llmgateway is listed only to name its secret
 * and stays off as a `gateway`.
 */
export const chatProbes: Array<ChatCompletionsProbe> = [
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    // "'reasoning_effort' does not support 'none' with this model.
    // Supported values are: …" is OpenAI's own per-model list.
    mandatoryRule: 'openai',
  },
  {
    provider: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    route: 'openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    // Groq's level list is per model (qwen3 takes `none`, gpt-oss does
    // not), and `reasoning_effort` is the gpt-oss models' only control.
    mandatoryRule: 'groq',
  },
  {
    provider: 'cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'CEREBRAS_API_KEY',
  },
  {
    provider: 'deepseek',
    url: 'https://api.deepseek.com/chat/completions',
    route: 'chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    provider: 'fireworks',
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'FIREWORKS_API_KEY',
  },
  {
    provider: 'together',
    url: 'https://api.together.xyz/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'TOGETHER_API_KEY',
  },
  {
    provider: 'mistral',
    url: 'https://api.mistral.ai/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'MISTRAL_API_KEY',
  },
  {
    provider: 'moonshot',
    url: 'https://api.moonshot.ai/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'MOONSHOT_API_KEY',
  },
  {
    provider: 'novita',
    url: 'https://api.novita.ai/openai/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'NOVITA_API_KEY',
  },
  {
    provider: 'sambanova',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'SAMBANOVA_API_KEY',
  },
  {
    provider: 'hyperbolic',
    url: 'https://api.hyperbolic.xyz/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'HYPERBOLIC_API_KEY',
  },
  {
    provider: 'grok',
    url: 'https://api.x.ai/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'XAI_API_KEY',
  },
  {
    provider: 'dashscope',
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    route: 'chat/completions',
    keyEnv: 'DASHSCOPE_API_KEY',
  },
  {
    provider: 'baseten',
    url: 'https://inference.baseten.co/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: 'BASETEN_API_KEY',
  },
  {
    provider: 'llmgateway',
    url: 'https://api.llmgateway.io/v1/chat/completions',
    route: 'v1/chat/completions',
    keyEnv: LLMGATEWAY_KEY_SECRET,
    // No captured response shows a 400 in LLM Gateway's own wording rather
    // than one forwarded from the upstream; until one does, it stays off.
    gateway: true,
  },
]

export function chatProbeFor(provider: string): ChatCompletionsProbe | null {
  return chatProbes.find((probe) => probe.provider === provider) ?? null
}

export function probesFor(provider: string): Array<ProbeRecord> {
  return probeRecords.filter((record) => record.provider === provider)
}

function namesModel(route: string, model: string): boolean {
  return route.split('/').some((segment) => segment.split(':')[0] === model)
}

/**
 * The route a catalog row may bind. `:generateContent` wins when that
 * model has several records. Another model's record never matches.
 */
export function probedRoute(provider: string, model: string): string | null {
  const matches = probesFor(provider).filter(
    (record) => record.model === model && namesModel(record.route, model),
  )
  const primary =
    matches.find((record) => record.route.endsWith(':generateContent')) ??
    (matches.length === 1 ? matches[0] : undefined)
  return primary?.route ?? null
}

export function probeFactSource(
  provider: string,
  model: string,
  route: string,
): FactSource | null {
  const record = probesFor(provider).find(
    (item) => item.model === model && item.route === route,
  )
  if (!record) return null
  const source = SOURCE[provider]
  if (!source) return null
  return {
    derivation: 'probe-verified',
    verifiedAt: record.verifiedAt,
    sourceUrl: `${source}#${record.id}`,
  }
}

/** LEGACY route records whose `verifiedAt` is older than `PROBE_STALE_DAYS`. */
export function staleRouteRecordCount(
  provider: string,
  now = new Date(),
): number {
  return probesFor(provider).filter((record) =>
    probeIsStale(record.verifiedAt, now),
  ).length
}

function probedSource(fact: ServedProbeFact): FactSource {
  return {
    derivation: 'probe-verified',
    verifiedAt: fact.verifiedAt,
    sourceUrl: fact.sourceUrl,
  }
}

/**
 * Fills a row's empty facts from served probe facts naming this exact
 * model and the route the row binds. A stated value is never replaced: a
 * probe fills a gap. `requestMap` is the map the row would store.
 */
export function withProbedFacts(
  info: ModelInfo,
  provider: string,
  route: string | null,
  requestMap: ChatRequestMap | null,
  served: Array<ServedProbeFact>,
): ModelInfo {
  const mine = served.filter(
    (fact) =>
      fact.provider === provider &&
      fact.model === info.rawId &&
      fact.route === route,
  )
  if (mine.length === 0) return info
  const next: ModelInfo = { ...info, factSources: { ...info.factSources } }
  const sources = next.factSources!
  for (const record of mine) {
    const { fact, value } = record
    if (fact === 'maxOutput' || fact === 'contextWindow') {
      if (typeof value !== 'number' || next[fact] != null) continue
      if (next.absent?.[fact]) continue
      next[fact] = value
      sources[fact] = probedSource(record)
    } else if (fact === 'replayReasoningContent') {
      const map = requestMap ?? blankRequestMap({})
      if (typeof value !== 'boolean' || map.replayReasoningContent !== null) {
        continue
      }
      next.requestMap = { ...map, replayReasoningContent: value }
      sources.requestMapFields = {
        ...sources.requestMapFields,
        replayReasoningContent: probedSource(record),
      }
    } else {
      // A refused `reasoning_effort: none` speaks only to an effort row.
      const reasoning = next.reasoning
      if (value !== true || reasoning?.mode !== 'effort') continue
      if (reasoning.mandatory !== null) continue
      const filled = { ...reasoning, mandatory: true }
      if (reasoningViolation(filled)) continue
      next.reasoning = filled
      sources.reasoningMandatory = probedSource(record)
    }
  }
  return next
}
