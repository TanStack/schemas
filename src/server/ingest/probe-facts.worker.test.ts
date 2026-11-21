import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { models } from '#/db/schema.ts'
import { pollProviderModels } from '#/server/ingest/poll-models.ts'
import {
  PROBE_PROVIDER_BUDGET,
  PROBE_REQUEST_BUDGET,
  REVERIFY_AFTER_DAYS,
  loadServedProbeFacts,
  planProbes,
  readProbeObservations,
  runProbes,
  staleProbeCounts,
} from '#/server/ingest/probe-facts.ts'
import type { SyncDeps } from '#/server/ingest/sync.ts'
import { provider as groq } from '#/server/providers/adapters/groq.ts'
import type { ChatCompletionsProbe } from '#/server/providers/probes/chat-completions.ts'
import { chatProbeFor } from '#/server/providers/probes/index.ts'
import type { ModelInfo } from '#/server/providers/types.ts'

const KEY = 'gsk_test_0123456789abcdefKEYEND'
const DAY = 86_400
const T0 = 1_795_000_000

const groqProbe = chatProbeFor('groq')!

function pollDeps(now: number): SyncDeps {
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: {}, now: () => now }
}

function poll(now: number, listed: Array<ModelInfo>) {
  return pollProviderModels(pollDeps(now), {
    ...groq,
    listModels: async () => ({ models: listed }),
  })
}

/** A Groq-worded 400 per check; `limit` is the cap the limits check states. */
function groqStub(limit: number, sent: Array<Record<string, unknown>>) {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    sent.push(body)
    const message =
      body.max_tokens === 1
        ? `'messages.1' : for 'role:assistant' the following must be satisfied[('messages.1' : property 'reasoning_content' is unsupported)] key=${KEY}`
        : `\`max_tokens\` must be less than or equal to \`${limit}\`, the maximum value for \`max_tokens\` is less than the \`context_window\` for this model`
    return Response.json({ error: { message } }, { status: 400 })
  }
}

function run(now: number, limit: number, sent: Array<Record<string, unknown>>) {
  return runProbes({
    db: getDb(env),
    secrets: { GROQ_API_KEY: KEY },
    now: () => now,
    fetch: groqStub(limit, sent),
    probes: [groqProbe],
  })
}

async function storedMaxOutput(rawId: string) {
  const [row] = await getDb(env)
    .select({ maxOutput: models.maxOutput, factSources: models.factSources })
    .from(models)
    .where(and(eq(models.providerId, 'groq'), eq(models.rawId, rawId)))
  return row!
}

describe('probe cron (#717)', () => {
  it('probes new rows, serves only after two agreeing runs, un-serves on disagreement', async () => {
    const listed: Array<ModelInfo> = [
      { rawId: 'lab/fresh', activity: 'chat' },
      { rawId: 'lab/stated', activity: 'chat', maxOutput: 8192 },
      { rawId: 'lab/embed', activity: 'embeddings' },
    ]
    await poll(T0, listed)

    // Run 1: first appearance. Only the row with an empty fact is probed.
    const sent: Array<Record<string, unknown>> = []
    const first = await run(T0 + 60, 65536, sent)
    const limits = sent.filter((body) => body.max_tokens === 10_000_000)
    expect(limits.map((body) => body.model)).toEqual(['lab/fresh'])
    expect(sent.some((body) => body.model === 'lab/embed')).toBe(false)
    expect(first.decided).toBe(sent.length)
    const stored = await readProbeObservations(getDb(env), 'groq', 'lab/fresh')
    expect(stored.every((row) => !row.message.includes(KEY))).toBe(true)
    expect(stored.every((row) => !row.served)).toBe(true)
    // One observation is stored, not served.
    expect(await loadServedProbeFacts(getDb(env), 'groq')).toEqual([])
    await poll(T0 + 120, listed)
    expect((await storedMaxOutput('lab/fresh')).maxOutput).toBeNull()

    // Run 2, a separate run: confirms, so the value is served.
    const confirm: Array<Record<string, unknown>> = []
    await run(T0 + 3_600, 65536, confirm)
    expect(confirm.length).toBeGreaterThan(0)
    const served = await loadServedProbeFacts(getDb(env), 'groq')
    expect(served).toContainEqual({
      provider: 'groq',
      model: 'lab/fresh',
      route: 'openai/v1/chat/completions',
      fact: 'maxOutput',
      value: 65536,
      verifiedAt: new Date((T0 + 3_600) * 1000).toISOString().slice(0, 10),
      sourceUrl: groqProbe.url,
    })
    await poll(T0 + 3_700, listed)
    const filled = await storedMaxOutput('lab/fresh')
    expect(filled.maxOutput).toBe(65536)
    expect(filled.factSources).toMatchObject({
      maxOutput: { derivation: 'probe-verified', sourceUrl: groqProbe.url },
    })
    // Stated value kept; the probe never touched that row.
    expect((await storedMaxOutput('lab/stated')).maxOutput).toBe(8192)

    // Docs win: a listing that states the fact replaces nothing with the probe.
    await poll(T0 + 3_800, [{ ...listed[0]!, maxOutput: 4096 }, listed[1]!])
    expect((await storedMaxOutput('lab/fresh')).maxOutput).toBe(4096)

    // Served facts are not re-probed until the slow cycle.
    const quiet: Array<Record<string, unknown>> = []
    await run(T0 + 7_200, 65536, quiet)
    expect(quiet).toEqual([])

    // Re-verify after REVERIFY_AFTER_DAYS: a disagreeing value un-serves.
    const later = T0 + (REVERIFY_AFTER_DAYS + 1) * DAY
    const reverify: Array<Record<string, unknown>> = []
    const disagree = await run(later, 32768, reverify)
    expect(reverify.some((body) => body.max_tokens === 10_000_000)).toBe(true)
    expect(disagree.disagreed).toBe(1)
    const after = await loadServedProbeFacts(getDb(env), 'groq')
    expect(after.find((fact) => fact.fact === 'maxOutput')).toBeUndefined()

    // Two newer agreeing observations serve the new value.
    await run(later + 3_600, 32768, [])
    const again = await loadServedProbeFacts(getDb(env), 'groq')
    expect(again.find((fact) => fact.fact === 'maxOutput')?.value).toBe(32768)

    // Stale count: served facts older than 90 days, from the table.
    const stale = await staleProbeCounts(
      getDb(env),
      new Date((later + 3_600 + 91 * DAY) * 1000),
    )
    expect(stale.get('groq')).toBe(again.length)
    expect(
      (await staleProbeCounts(getDb(env), new Date(later * 1000))).get('groq'),
    ).toBeUndefined()
  })

  it('skips a missing key and a gateway without sending anything', async () => {
    const sent: Array<Record<string, unknown>> = []
    const fetch = groqStub(1, sent)
    const missing = await runProbes({
      db: getDb(env),
      secrets: {},
      fetch,
      probes: [groqProbe],
    })
    expect(missing.skipped).toEqual([
      { provider: 'groq', reason: 'GROQ_API_KEY is not set' },
    ])
    const gateway = await runProbes({
      db: getDb(env),
      secrets: { LLMGATEWAY_API_KEY: KEY },
      fetch,
      probes: [chatProbeFor('llmgateway')!],
    })
    expect(gateway.skipped[0]?.reason).toMatch(/^gateway/)
    expect(sent).toEqual([])
    expect(missing.sent + gateway.sent).toBe(0)
  })
})

describe('planProbes', () => {
  const probes: Array<ChatCompletionsProbe> = ['a', 'b', 'c', 'd', 'e'].map(
    (provider) => ({
      provider,
      url: `https://${provider}.example/v1/chat/completions`,
      route: 'v1/chat/completions',
      keyEnv: 'K',
    }),
  )
  const row = (
    providerId: string,
    rawId: string,
    route = 'v1/chat/completions',
  ) => ({
    providerId,
    rawId,
    activity: 'chat' as const,
    capabilities: null,
    schemaEndpointId: route,
    maxOutput: null,
    reasoning: null,
    requestMap: { replayReasoningContent: false },
  })

  it('caps each invocation and each provider, and interleaves providers', () => {
    const rows = probes.flatMap((probe) =>
      Array.from({ length: 10 }, (_, i) => row(probe.provider, `m${i}`)),
    )
    const { planned, backlog } = planProbes(rows, [], probes, T0)
    expect(planned).toHaveLength(PROBE_REQUEST_BUDGET)
    expect(backlog).toBe(50 - PROBE_REQUEST_BUDGET)
    const per = new Map<string, number>()
    for (const p of planned)
      per.set(p.probe.provider, (per.get(p.probe.provider) ?? 0) + 1)
    for (const n of per.values())
      expect(n).toBeLessThanOrEqual(PROBE_PROVIDER_BUDGET)
    // Round robin: the first five are one per provider.
    expect(new Set(planned.slice(0, 5).map((p) => p.probe.provider)).size).toBe(
      5,
    )
  })

  it('binds only the exact route', () => {
    const { planned } = planProbes(
      [row('a', 'm', 'v1/responses')],
      [],
      probes,
      T0,
    )
    expect(planned).toEqual([])
  })

  it('re-verifies the oldest observation first', () => {
    const obs = (rawId: string, observedAt: number, id: number) => ({
      id,
      runId: `r${id}`,
      providerId: 'a',
      rawId,
      route: 'v1/chat/completions',
      fact: 'maxOutput',
      value: null,
      status: 200,
      message: '200: a 2xx states nothing',
      observedAt,
    })
    const { planned } = planProbes(
      [row('a', 'newer'), row('a', 'older'), row('a', 'recent')],
      [
        obs('newer', T0 - 10 * DAY, 1),
        obs('older', T0 - 30 * DAY, 2),
        obs('recent', T0 - DAY, 3),
      ],
      probes,
      T0,
    )
    expect(planned.map((p) => [p.rawId, p.reason])).toEqual([
      ['older', 'reverify'],
      ['newer', 'reverify'],
    ])
  })
})
