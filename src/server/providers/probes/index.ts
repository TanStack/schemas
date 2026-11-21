import { blankRequestMap } from '../request-map.ts'
import type { ChatRequestMap } from '../request-map.ts'
import { reasoningViolation } from '../types.ts'
import type { FactSource, ModelInfo } from '../types.ts'
import type { ChatCompletionsProbe } from './chat-completions.ts'
import { probe as groqProbe } from './groq.ts'
import {
  OPENCODE_GO_PROBE_SOURCE,
  records as opencodeGo,
} from './opencode-go.ts'
import { records as groqRecords } from './records/groq.ts'
import { probeIsStale } from './types.ts'
import type { ProbedFactRecord, ProbeRecord } from './types.ts'

const SOURCE: Record<string, string> = {
  'opencode-go': OPENCODE_GO_PROBE_SOURCE,
}

/** Every committed probe. Add a provider by importing its module here. */
export const probeRecords: Array<ProbeRecord> = [...opencodeGo]

/**
 * Providers on the generic `chat/completions` probe (issue #717). Opt in
 * with `probes/<provider>.ts` exporting a `ChatCompletionsProbe`, an empty
 * `records/<provider>.ts`, and one entry in each list below. Set
 * `mandatoryRule` only for a provider whose `reasoning_effort` level list
 * is per model and is the model's only reasoning control.
 */
export const chatProbes: Array<ChatCompletionsProbe> = [groqProbe]

/** Every committed fact a live response stated. */
export const probedFactRecords: Array<ProbedFactRecord> = [...groqRecords]

/** The generated records file of a chat probe provider. */
export function probedFactFile(provider: string): string {
  return `src/server/providers/probes/records/${provider}.ts`
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

/** Records whose `verifiedAt` is older than `PROBE_STALE_DAYS`. */
export function staleProbeCount(provider: string, now = new Date()): number {
  return [
    ...probesFor(provider),
    ...probedFactRecords.filter((record) => record.provider === provider),
  ].filter((record) => probeIsStale(record.verifiedAt, now)).length
}

function probedSource(record: ProbedFactRecord): FactSource {
  return {
    derivation: 'probe-verified',
    verifiedAt: record.verifiedAt,
    sourceUrl: `${probedFactFile(record.provider)}#${record.id}`,
  }
}

/**
 * Fills a row's empty facts from probe records naming this exact model
 * and the route the row binds. A stated value is never replaced: a probe
 * fills a gap. `requestMap` is the map the row would store.
 */
export function withProbedFacts(
  info: ModelInfo,
  provider: string,
  route: string | null,
  requestMap: ChatRequestMap | null,
  records: Array<ProbedFactRecord> = probedFactRecords,
): ModelInfo {
  const mine = records.filter(
    (record) =>
      record.provider === provider &&
      record.model === info.rawId &&
      record.route === route,
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
