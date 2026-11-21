/**
 * A live check against a provider API, kept as data (issue #461).
 * One module per provider under this directory. Adapters bind a fact only
 * when a record names that exact model and route. A record older than
 * `PROBE_STALE_DAYS` is still served; `GET /v1/status` counts those as
 * `staleProbes`. Re-run with `pnpm run probe -- <provider> [--write]`;
 * `.source/workflows/probe.ts` runs it weekly for the chat probes.
 */
export const PROBE_STALE_DAYS = 90

export interface ProbeRequest {
  method: 'POST'
  /** Path and query on the provider origin. No secrets. */
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface ProbeExpect {
  status: number
  /** Top-level JSON keys the response must have. */
  jsonKeys: Array<string>
  /** `true` when the body is SSE and each `data:` payload is that JSON. */
  sse?: boolean
}

export interface ProbeRecord {
  id: string
  provider: string
  /** Catalog raw id. A record never applies to another id in the family. */
  model: string
  fact: 'schemaEndpointId'
  /** Endpoint id without a leading slash. */
  route: string
  /** `YYYY-MM-DD` the live call last matched `expect`. */
  verifiedAt: string
  /** Who ran the call. */
  ranBy: string
  request: ProbeRequest
  expect: ProbeExpect
  /**
   * The live error stated this model trains on request data and needs the
   * workspace opt-in. Set only on a call that returned that statement.
   * Never inferred from an id suffix.
   */
  trainsOnRequestData?: true
}

/** Facts the generic `chat/completions` probe can state (issue #717). */
export type ProbedFact =
  | 'maxOutput'
  | 'contextWindow'
  | 'replayReasoningContent'
  | 'reasoning.mandatory'

/**
 * One fact a live response stated. Written only by
 * `pnpm run probe -- <provider> --write` into `records/<provider>.ts`;
 * never by hand. A run that cannot decide leaves the record as it was.
 */
export interface ProbedFactRecord {
  id: string
  provider: string
  /** Catalog raw id. A record never applies to another id in the family. */
  model: string
  fact: ProbedFact
  value: number | boolean
  /** Endpoint id the row must bind for the record to apply. */
  route: string
  /** `YYYY-MM-DD` of the run whose response stated `value`. */
  verifiedAt: string
  ranBy: string
  /** What was sent, without headers. */
  request: { url: string; body: Record<string, unknown> }
  /** The status and the error message that stated the value. */
  evidence: { status: number; message: string }
}

const DAY_MS = 86_400_000

export function probeAgeDays(verifiedAt: string, now: Date): number {
  const verified = Date.parse(`${verifiedAt}T00:00:00.000Z`)
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  if (!Number.isFinite(verified)) return Number.POSITIVE_INFINITY
  return Math.floor((today - verified) / DAY_MS)
}

/** Age strictly greater than `PROBE_STALE_DAYS`. The boundary day still counts as current. */
export function probeIsStale(verifiedAt: string, now = new Date()): boolean {
  return probeAgeDays(verifiedAt, now) > PROBE_STALE_DAYS
}
