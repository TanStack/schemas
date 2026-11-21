import { probeAgeDays } from './types.ts'
import type { ProbedFact, ProbedFactRecord } from './types.ts'

/**
 * The generic probe for the OpenAI-style `chat/completions` wire (issue
 * #717). A provider opts in with one `ChatCompletionsProbe` and an empty
 * records file; `pnpm run probe -- <provider> --write` fills the records.
 *
 * A value is recorded only from a response that states it: a 400 or 422
 * whose message gives the limit as a number, or names the field it
 * refuses. A 2xx states nothing, nor does a timeout, a 5xx, a rate limit,
 * an auth or billing error, or any message no rule below reads.
 */
export interface ChatCompletionsProbe {
  provider: string
  /** Full URL of the chat completions endpoint. No secrets. */
  url: string
  /** The endpoint id a catalog row binds (`schemaEndpointId`). */
  route: string
  /** Env name of the bearer key. The key itself is never in a file. */
  keyEnv: string
  /** Catalog raw ids to probe. Each costs `probeChecks(probe).length` requests. */
  models: Array<string>
  /**
   * Opt in to the `off` check: whose refusal of `reasoning_effort: "none"`
   * is read, and only in that provider's own wording. Set it only when
   * that provider's level list is per model (not one enum shared by every
   * model, nor a gateway forwarding an upstream's 400) and
   * `reasoning_effort` is the model's only reasoning control. Without it
   * no `off` request is sent.
   */
  mandatoryRule?: MandatoryRule
}

export type MandatoryRule = 'groq' | 'openai'
export type ProbeCheck = 'limits' | 'replay' | 'off'

/** The checks one provider's run sends per model. */
export function probeChecks(probe: ChatCompletionsProbe): Array<ProbeCheck> {
  return probe.mandatoryRule
    ? ['limits', 'replay', 'off']
    : ['limits', 'replay']
}

/** Hard per-provider cap. A run that plans more requests aborts before the first. */
export const MAX_PROBE_REQUESTS = 30

/** Far over any model's output cap, so a provider that checks it says so. */
const OVERSIZED_MAX_TOKENS = 10_000_000

/**
 * Every body streams and the script cancels a 2xx unread. Cancelling does
 * not guarantee the provider stops billing; the real bound is the one-word
 * prompt (and `max_tokens: 1` on every check but `limits`).
 */
export function probeBody(
  check: ProbeCheck,
  model: string,
): Record<string, unknown> {
  const hi = [{ role: 'user', content: 'hi' }]
  if (check === 'limits') {
    return {
      model,
      stream: true,
      messages: hi,
      max_tokens: OVERSIZED_MAX_TOKENS,
    }
  }
  if (check === 'replay') {
    return {
      model,
      stream: true,
      max_tokens: 1,
      messages: [
        ...hi,
        { role: 'assistant', content: 'ok', reasoning_content: 'x' },
        ...hi,
      ],
    }
  }
  return {
    model,
    stream: true,
    max_tokens: 1,
    messages: hi,
    reasoning_effort: 'none',
  }
}

export type ProbeOutcome =
  | { fact: ProbedFact; value: number | boolean; message: string }
  | { undecided: string }

/** The error text a provider put in the body, or null when it put none. */
export function errorMessage(body: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const record = json as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message) return message
  }
  if (typeof error === 'string' && error) return error
  if (typeof record.message === 'string' && record.message) {
    return record.message
  }
  // FastAPI / pydantic: `detail: [{ type, loc, msg }]`.
  if (Array.isArray(record.detail)) {
    const parts = record.detail.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const { type, loc, msg } = item as Record<string, unknown>
      if (typeof msg !== 'string') return []
      const path = Array.isArray(loc) ? loc.join('.') : ''
      return [`${String(type)} at ${path}: ${msg}`]
    })
    if (parts.length > 0) return parts.join('; ')
  }
  return null
}

function statusReason(status: number): string | null {
  if (status === 0) return 'no response (network error or timeout)'
  if (status >= 200 && status < 300) return `${status}: a 2xx states nothing`
  if (status === 401 || status === 403) return `${status}: auth or permission`
  if (status === 402) return '402: billing'
  if (status === 404) return '404: model or route not found'
  if (status === 408) return '408: timeout'
  if (status === 429) return '429: rate limit or quota'
  if (status >= 500) return `${status}: server error`
  if (status !== 400 && status !== 422)
    return `${status}: not a validation error`
  return null
}

/** `'a', 'b'` or `` `a`, `b` `` → the quoted values. */
function quotedValues(text: string): Array<string> {
  return [...text.matchAll(/['`]([a-z_]+)['`]/g)].map((match) => match[1]!)
}

const OFF_VALUES = new Set(['none', 'off', 'disabled', 'disable'])

/**
 * The level list a 400 gave for this model's `reasoning_effort`, when it
 * refused `none`, read only in the opted-in provider's wording. Null when
 * the message is anything else.
 */
function refusedOffLevels(
  message: string,
  rule: MandatoryRule,
): Array<string> | null {
  const pattern =
    rule === 'openai'
      ? // "Unsupported value: 'reasoning_effort' does not support 'none'
        // with this model. Supported values are: 'minimal', 'low', ...".
        /'reasoning_effort' does not support 'none' with this model\. Supported values are: (.+)$/
      : // "`reasoning_effort` must be one of `low`, `medium`, or `high`".
        /^`reasoning_effort` must be one of (.+)$/
  const list = pattern.exec(message)?.[1]
  if (!list) return null
  const levels = quotedValues(list)
  return levels.length > 0 ? levels : null
}

/**
 * Reads one probe response. Pure: the only inputs are the check, the
 * status, the raw body and the provider's `mandatoryRule`. Each rule
 * matches a wording seen in a live response
 * (`fixtures/probe-responses.json`). No rule writes `contextWindow` yet:
 * no live response has stated one.
 */
export function classifyProbeResponse(
  check: ProbeCheck,
  status: number,
  body: string,
  mandatoryRule?: MandatoryRule,
): ProbeOutcome {
  if (check === 'off' && !mandatoryRule) {
    return { undecided: 'off: the provider has no mandatoryRule opt-in' }
  }
  const reason = statusReason(status)
  if (reason) return { undecided: reason }
  const message = errorMessage(body)
  if (!message) return { undecided: `${status} with no error message` }

  if (check === 'limits') {
    // OpenAI: "This model supports at most 16384 completion tokens".
    const openai = /This model supports at most (\d+) completion tokens/.exec(
      message,
    )
    // Groq: "`max_tokens` must be less than or equal to `65536`, the
    // maximum value for `max_tokens` is less than the `context_window`".
    const groq =
      /^`max_tokens` must be less than or equal to `(\d+)`, the maximum value for `max_tokens`/.exec(
        message,
      )
    const output = openai?.[1] ?? groq?.[1]
    if (output) {
      return { fact: 'maxOutput', value: Number(output), message }
    }
    return { undecided: `${status} names no limit a rule reads: ${message}` }
  }

  if (check === 'replay') {
    // The assistant turn carried `reasoning_content` and the provider
    // refused that field by name: it takes no replay, so needs none.
    const pydantic =
      /extra_forbidden at body\.messages\.\d+\.assistant\.reasoning_content: /.test(
        message,
      )
    const groq = /property 'reasoning_content' is unsupported/.test(message)
    if (pydantic || groq) {
      return { fact: 'replayReasoningContent', value: false, message }
    }
    return {
      undecided: `${status} does not refuse reasoning_content by name: ${message}`,
    }
  }

  const levels = refusedOffLevels(message, mandatoryRule!)
  if (!levels) {
    return {
      undecided: `${status} does not list this model's reasoning_effort levels: ${message}`,
    }
  }
  if (levels.some((level) => OFF_VALUES.has(level))) {
    return { undecided: `${status} lists an off level: ${message}` }
  }
  // The model's own exhaustive level list, with no off value.
  return { fact: 'reasoning.mandatory', value: true, message }
}

/** Under the 90 stale days, so a weekly run re-dates a record in time. */
export const REDATE_AFTER_DAYS = 60

/**
 * One provider's records after a run. A decided check replaces its stored
 * record, or keeps it unchanged when the value is the same and the record
 * is at most `REDATE_AFTER_DAYS` old. A stored record the run did not
 * decide is kept and listed in `unconfirmed`. Another provider's records
 * are never read.
 */
export function mergeProbedRecords(
  provider: string,
  stored: Array<ProbedFactRecord>,
  found: Array<ProbedFactRecord>,
  now: Date,
): {
  records: Array<ProbedFactRecord>
  unconfirmed: Array<ProbedFactRecord>
} {
  const mine = new Map(
    stored
      .filter((record) => record.provider === provider)
      .map((record) => [record.id, record] as const),
  )
  const decided = found.map((record) => {
    const prior = mine.get(record.id)
    return prior &&
      prior.value === record.value &&
      probeAgeDays(prior.verifiedAt, now) <= REDATE_AFTER_DAYS
      ? prior
      : record
  })
  const ids = new Set(decided.map((record) => record.id))
  const unconfirmed = [...mine.values()].filter((record) => !ids.has(record.id))
  const records = [...unconfirmed, ...decided].sort((a, b) =>
    a.id.localeCompare(b.id),
  )
  return { records, unconfirmed }
}
