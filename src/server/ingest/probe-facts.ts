/**
 * Live probes in the Worker (issue #717). The probe cron picks chat rows of
 * probe-enabled providers, sends one minimal request per check, reads the
 * response with the pure `classifyProbeResponse`, and appends what it saw
 * to `probe_observations`. Nothing else writes that table, and nothing
 * updates or deletes a row.
 *
 * Serving: a value is served only once the two newest decided
 * observations, from separate runs, agree. The models poll reads the
 * served facts (`loadServedProbeFacts`) and fills only empty facts on the
 * exact model and route observed (`withProbedFacts`).
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models, probeObservations } from '#/db/schema.ts'
import {
  CHECK_FACT,
  classifyProbeResponse,
  probeBody,
  probeChecks,
  redactKey,
  sendProbe,
} from '#/server/providers/probes/chat-completions.ts'
import type {
  ChatCompletionsProbe,
  ProbeCheck,
} from '#/server/providers/probes/chat-completions.ts'
import { chatProbeFor, chatProbes } from '#/server/providers/probes/index.ts'
import { probeIsStale } from '#/server/providers/probes/types.ts'
import type {
  ProbedFact,
  ServedProbeFact,
} from '#/server/providers/probes/types.ts'
import { errorMessage } from '#/server/errors.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import {
  captureIngestEvents,
  ingestFailedEvent,
  noteIngest,
  runIngestScope,
} from './ingest-signals.ts'
import type { Activity } from '#/db/schema.ts'

/** Hourly at :07, its own invocation, after the :00 models poll. */
export const PROBE_CRON = '7 * * * *'
/**
 * One `PROBE_CRON` interval. Two agreeing observations must be at least
 * this far apart (`observed_at` is the firing's scheduled time).
 */
export const PROBE_RUN_GAP_SECONDS = 3_600
/** Hard cap on provider requests per cron invocation (all providers). */
export const PROBE_REQUEST_BUDGET = 12
/** Hard cap on requests to one provider per cron invocation. */
export const PROBE_PROVIDER_BUDGET = 4
/** The slow cycle: a fact whose last attempt is this old is probed again. */
export const REVERIFY_AFTER_DAYS = 7

const MESSAGE_MAX = 1_000
const DAY_SECONDS = 86_400

type Observation = typeof probeObservations.$inferSelect

type ObservationKey = Pick<
  Observation,
  'providerId' | 'rawId' | 'route' | 'fact'
>

function keyOf(row: ObservationKey): string {
  return [row.providerId, row.rawId, row.route, row.fact].join('\u0000')
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

function newestFirst(a: Observation, b: Observation): number {
  return b.observedAt - a.observedAt || b.id - a.id
}

/**
 * The two observations that decide a fact: the newest decided one and the
 * newest decided one at least `PROBE_RUN_GAP_SECONDS` older. Served when
 * both exist and agree. The gap, not the run id, keeps two overlapping
 * invocations (one moment) from counting as two runs.
 */
function decidingPair(
  history: Array<Observation>,
): [Observation, Observation | undefined] | null {
  const decided = history.filter((row) => row.value !== null).sort(newestFirst)
  const newest = decided[0]
  if (!newest) return null
  return [
    newest,
    decided.find(
      (row) => row.observedAt <= newest.observedAt - PROBE_RUN_GAP_SECONDS,
    ),
  ]
}

function groupByKey(rows: Array<Observation>): Map<string, Array<Observation>> {
  const groups = new Map<string, Array<Observation>>()
  for (const row of rows) {
    const key = keyOf(row)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return groups
}

/**
 * The facts the catalog serves, and the ids of the observations behind
 * them. A provider no longer on the probe list serves nothing.
 */
export function servedProbeFacts(rows: Array<Observation>): {
  served: Array<ServedProbeFact>
  servingIds: Set<number>
} {
  const served: Array<ServedProbeFact> = []
  const servingIds = new Set<number>()
  for (const history of groupByKey(rows).values()) {
    const pair = decidingPair(history)
    const probe = pair && chatProbeFor(pair[0].providerId)
    if (!pair || !probe || !pair[1]) continue
    const [newest, previous] = pair
    if (newest.value !== previous.value) continue
    const value = newest.value
    if (typeof value !== 'number' && typeof value !== 'boolean') continue
    served.push({
      provider: newest.providerId,
      model: newest.rawId,
      route: newest.route,
      fact: newest.fact as ProbedFact,
      value,
      verifiedAt: day(newest.observedAt),
      sourceUrl: probe.url,
    })
    servingIds.add(newest.id).add(previous.id)
  }
  return { served, servingIds }
}

/** One provider's served facts, for the models poll. */
export async function loadServedProbeFacts(
  db: Db,
  providerId: string,
): Promise<Array<ServedProbeFact>> {
  if (!chatProbeFor(providerId)) return []
  const rows = await db
    .select()
    .from(probeObservations)
    .where(
      and(
        eq(probeObservations.providerId, providerId),
        isNotNull(probeObservations.value),
      ),
    )
  return servedProbeFacts(rows).served
}

/** Served facts older than `PROBE_STALE_DAYS`, per provider. */
export async function staleProbeCounts(
  db: Db,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(probeObservations)
    .where(isNotNull(probeObservations.value))
  const counts = new Map<string, number>()
  for (const fact of servedProbeFacts(rows).served) {
    if (!probeIsStale(fact.verifiedAt, now)) continue
    counts.set(fact.provider, (counts.get(fact.provider) ?? 0) + 1)
  }
  return counts
}

/** Admin audit: every observation, newest first, marked when it is served. */
export async function readProbeObservations(
  db: Db,
  providerId: string,
  rawId?: string,
): Promise<Array<Omit<Observation, 'id'> & { id: number; served: boolean }>> {
  const all = await db
    .select()
    .from(probeObservations)
    .where(eq(probeObservations.providerId, providerId))
  const { servingIds } = servedProbeFacts(all)
  return all
    .filter((row) => rawId === undefined || row.rawId === rawId)
    .sort(newestFirst)
    .map((row) => ({ ...row, served: servingIds.has(row.id) }))
}

interface ProbeRow {
  providerId: string
  rawId: string
  activity: Activity | null
  capabilities: unknown
  schemaEndpointId: string | null
  maxOutput: number | null
  reasoning: unknown
  requestMap: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when the stored row has nothing for the fact a check can state. */
function factIsEmpty(row: ProbeRow, fact: ProbedFact): boolean {
  if (fact === 'maxOutput') return row.maxOutput === null
  if (fact === 'replayReasoningContent') {
    return (
      !isRecord(row.requestMap) || row.requestMap.replayReasoningContent == null
    )
  }
  if (fact === 'reasoning.mandatory') {
    return (
      isRecord(row.reasoning) &&
      row.reasoning.mode === 'effort' &&
      row.reasoning.mandatory === null
    )
  }
  return false
}

export type ProbeReason = 'new' | 'confirm' | 'reverify'

export interface PlannedProbe {
  probe: ChatCompletionsProbe
  rawId: string
  check: ProbeCheck
  reason: ProbeReason
  /** The newest decided value before this run, for the disagreement log. */
  prior: number | boolean | null
}

/**
 * Which probes this invocation sends, in order, under both caps:
 * - `confirm`: the newest attempt was decided but is not served yet, and
 *   is at least `PROBE_RUN_GAP_SECONDS` old;
 * - `new`: the row's fact is empty and it has no observation at all;
 * - `reverify`: the newest attempt is `REVERIFY_AFTER_DAYS` old, oldest
 *   first (an undecided fact only while the row still lacks it).
 * New and confirm interleave providers so one provider cannot starve the
 * rest. The rest is the backlog for the next invocation.
 */
export function planProbes(
  rows: Array<ProbeRow>,
  observations: Array<Observation>,
  probes: Array<ChatCompletionsProbe>,
  now: number,
): { planned: Array<PlannedProbe>; backlog: number } {
  const byProvider = new Map(probes.map((probe) => [probe.provider, probe]))
  const history = groupByKey(observations)
  const candidates: Array<PlannedProbe & { order: number }> = []
  const rank = new Map<string, number>()
  const nextRank = (reason: ProbeReason, provider: string) => {
    const key = `${reason}\u0000${provider}`
    const value = rank.get(key) ?? 0
    rank.set(key, value + 1)
    return value
  }
  for (const row of rows) {
    const probe = byProvider.get(row.providerId)
    if (!probe) continue
    const route = resolveSchemaEndpointId({
      providerId: row.providerId,
      rawId: row.rawId,
      activity: row.activity,
      capabilities: row.capabilities,
      schemaEndpointId: row.schemaEndpointId,
    })
    // Exact route only: a fact observed on another route binds nothing.
    if (route !== probe.route) continue
    for (const check of probeChecks(probe)) {
      const fact = CHECK_FACT[check]
      const seen = history.get(
        keyOf({ providerId: row.providerId, rawId: row.rawId, route, fact }),
      )
      const base = { probe, rawId: row.rawId, check }
      if (!seen) {
        if (!factIsEmpty(row, fact)) continue
        candidates.push({
          ...base,
          reason: 'new',
          prior: null,
          order: nextRank('new', probe.provider),
        })
        continue
      }
      const latest = [...seen].sort(newestFirst)[0]!
      const pair = decidingPair(seen)
      const prior = pair ? (pair[0].value as number | boolean) : null
      const servedNow =
        pair !== null &&
        pair[1] !== undefined &&
        pair[0].value === pair[1].value
      if (latest.value !== null && !servedNow) {
        // Too soon to count as a second run: confirm on a later firing.
        if (latest.observedAt > now - PROBE_RUN_GAP_SECONDS) continue
        candidates.push({
          ...base,
          reason: 'confirm',
          prior,
          order: nextRank('confirm', probe.provider),
        })
        continue
      }
      if (latest.observedAt > now - REVERIFY_AFTER_DAYS * DAY_SECONDS) continue
      if (pair === null && !factIsEmpty(row, fact)) continue
      candidates.push({
        ...base,
        reason: 'reverify',
        prior,
        order: latest.observedAt,
      })
    }
  }
  // Confirm first: it is bounded by the decided, unserved values, and
  // behind a long `new` backlog nothing would ever be served.
  const tier: Record<ProbeReason, number> = { confirm: 0, new: 1, reverify: 2 }
  candidates.sort(
    (a, b) => tier[a.reason] - tier[b.reason] || a.order - b.order,
  )
  const planned: Array<PlannedProbe> = []
  const perProvider = new Map<string, number>()
  for (const { order: _order, ...candidate } of candidates) {
    if (planned.length >= PROBE_REQUEST_BUDGET) break
    const used = perProvider.get(candidate.probe.provider) ?? 0
    if (used >= PROBE_PROVIDER_BUDGET) continue
    perProvider.set(candidate.probe.provider, used + 1)
    planned.push(candidate)
  }
  return { planned, backlog: candidates.length - planned.length }
}

export interface ProbeDeps {
  db: Db
  secrets: object
  now?: () => number
  fetch?: typeof fetch
  probes?: Array<ChatCompletionsProbe>
}

export interface ProbeRunOutcome {
  runId: string
  sent: number
  decided: number
  undecided: number
  disagreed: number
  backlog: number
  skipped: Array<{ provider: string; reason: string }>
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ job: 'probe', ...entry }))
}

/** One cron invocation: plan under the caps, send, append observations. */
export async function runProbes(deps: ProbeDeps): Promise<ProbeRunOutcome> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const fetcher = deps.fetch ?? fetch
  const outcome: ProbeRunOutcome = {
    runId: crypto.randomUUID(),
    sent: 0,
    decided: 0,
    undecided: 0,
    disagreed: 0,
    backlog: 0,
    skipped: [],
  }
  const keys = new Map<string, string>()
  const active: Array<ChatCompletionsProbe> = []
  for (const probe of deps.probes ?? chatProbes) {
    if (probe.gateway) {
      outcome.skipped.push({
        provider: probe.provider,
        reason: 'gateway: no captured response shows its own wording',
      })
      continue
    }
    const raw = (deps.secrets as Record<string, unknown>)[probe.keyEnv]
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!key) {
      outcome.skipped.push({
        provider: probe.provider,
        reason: `${probe.keyEnv} is not set`,
      })
      continue
    }
    keys.set(probe.provider, key)
    active.push(probe)
  }
  for (const skip of outcome.skipped)
    log({ skip: skip.provider, reason: skip.reason })
  if (active.length === 0) return outcome

  const providerIds = active.map((probe) => probe.provider)
  const [rows, observations] = await Promise.all([
    deps.db
      .select({
        providerId: models.providerId,
        rawId: models.rawId,
        activity: models.activity,
        capabilities: models.capabilities,
        schemaEndpointId: models.schemaEndpointId,
        maxOutput: models.maxOutput,
        reasoning: models.reasoning,
        requestMap: models.requestMap,
      })
      .from(models)
      .where(
        and(
          inArray(models.providerId, providerIds),
          eq(models.activity, 'chat'),
          isNull(models.deprecatedAt),
        ),
      ),
    deps.db
      .select()
      .from(probeObservations)
      .where(inArray(probeObservations.providerId, providerIds)),
  ])
  const { planned, backlog } = planProbes(rows, observations, active, now)
  outcome.backlog = backlog

  for (const { probe, rawId, check, reason, prior } of planned) {
    const key = keys.get(probe.provider)!
    const body = probeBody(check, rawId)
    outcome.sent++
    const { status, text } = await sendProbe(probe.url, body, key, fetcher)
    const result = classifyProbeResponse(
      check,
      status,
      text,
      probe.mandatoryRule,
    )
    const decided = 'fact' in result
    const message = redactKey(
      decided ? result.message : result.undecided,
      key,
    ).slice(0, MESSAGE_MAX)
    await deps.db.insert(probeObservations).values({
      runId: outcome.runId,
      providerId: probe.provider,
      rawId,
      route: probe.route,
      fact: CHECK_FACT[check],
      value: decided ? result.value : null,
      status,
      message,
      observedAt: now,
    })
    const entry = {
      provider: probe.provider,
      model: rawId,
      check,
      reason,
      status,
    }
    if (!decided) {
      outcome.undecided++
      log({ ...entry, undecided: message })
      continue
    }
    outcome.decided++
    if (prior !== null && prior !== result.value) {
      outcome.disagreed++
      console.warn(
        JSON.stringify({
          job: 'probe',
          ...entry,
          disagreement: `observed ${String(result.value)}, previous ${String(prior)}; not served until two newer observations agree`,
        }),
      )
      continue
    }
    log({ ...entry, fact: result.fact, value: result.value })
  }
  return outcome
}

/**
 * The cron entry. A failure part way (D1, say) is logged and reported as
 * `ingest_failed` (job `probe`), then rethrown so the invocation fails;
 * the rest of the plan is the next firing's backlog.
 */
export async function runProbeCron(
  deps: ProbeDeps & { posthogKey?: string },
): Promise<ProbeRunOutcome> {
  return runIngestScope(async () => {
    try {
      return await runProbes(deps)
    } catch (error) {
      const message = errorMessage(error)
      console.error(JSON.stringify({ job: 'probe', error: message }))
      noteIngest(ingestFailedEvent('probe', '*', message))
      throw error
    } finally {
      await captureIngestEvents(deps.posthogKey)
    }
  })
}
