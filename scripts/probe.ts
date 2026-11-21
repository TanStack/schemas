// Run one provider's live probes. Spends a key and calls the provider.
// Never prints the key.
//
//   pnpm run probe -- <provider> [--write] [--skip-missing-key]
//
// Route records (opencode-go): `--write` sets `verifiedAt` to today on
// records that still match; a mismatch exits 1 and leaves the file alone.
//
// Chat probes (`chatProbes`, issue #717): every model gets each check in
// PROBE_CHECKS. A response that states a fact is printed; `--write`
// stores it in records/<provider>.ts. An undecided check prints why and
// keeps the stored record as it was. More than MAX_PROBE_REQUESTS planned
// requests aborts before the first. `--skip-missing-key` (the weekly CI
// job) reports a missing key and exits 0.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'

import {
  MAX_PROBE_REQUESTS,
  PROBE_CHECKS,
  classifyProbeResponse,
  probeBody,
} from '../src/server/providers/probes/chat-completions.ts'
import type { ChatCompletionsProbe } from '../src/server/providers/probes/chat-completions.ts'
import {
  bumpVerifiedAt,
  observationMatches,
} from '../src/server/providers/probes/compare.ts'
import {
  chatProbes,
  probedFactFile,
  probedFactRecords,
  probeRecords,
  probesFor,
} from '../src/server/providers/probes/index.ts'
import { OPENCODE_GO_PROBE_SOURCE } from '../src/server/providers/probes/opencode-go.ts'
import { probeAgeDays } from '../src/server/providers/probes/types.ts'
import type {
  ProbedFactRecord,
  ProbeRecord,
} from '../src/server/providers/probes/types.ts'

/** Under PROBE_STALE_DAYS, so a weekly run re-dates a record before it goes stale. */
const REDATE_AFTER_DAYS = 60

const ROUTE_PROBES: Record<
  string,
  { file: string; origin: string; keyEnv: string }
> = {
  'opencode-go': {
    file: OPENCODE_GO_PROBE_SOURCE,
    origin: 'https://opencode.ai',
    keyEnv: 'OPENCODE_GO_API_KEY',
  },
}

// pnpm 11 passes the `--` through.
const providerId = process.argv.slice(2).find((arg) => arg !== '--')
const write = process.argv.includes('--write')
const skipMissingKey = process.argv.includes('--skip-missing-key')
const chat = chatProbes.find((probe) => probe.provider === providerId)
const known = [
  ...new Set([
    ...probeRecords.map((record) => record.provider),
    ...chatProbes.map((probe) => probe.provider),
  ]),
]
if (!providerId || !known.includes(providerId)) {
  console.error(
    `usage: pnpm run probe -- <provider> [--write] [--skip-missing-key]\nproviders: ${known.join(', ')}`,
  )
  process.exit(1)
}
const today = new Date().toISOString().slice(0, 10)

if (chat) await runChatProbe(chat)
else await runRouteProbes()

async function runRouteProbes(): Promise<void> {
  const config = ROUTE_PROBES[providerId!]
  if (!config) throw new Error(`probe: ${providerId} has no route config`)
  const records = probesFor(providerId!)
  const apiKey = readKey(config.keyEnv)
  const mismatches: Array<string> = []
  for (const record of records) {
    const mismatch = await runRecord(record, config, apiKey)
    if (mismatch) mismatches.push(`${record.id}: ${mismatch}`)
    else console.log(`${record.id}: match`)
  }
  if (mismatches.length > 0) {
    for (const line of mismatches) console.error(line)
    process.exit(1)
  }
  if (write) {
    const next = records.reduce(
      (source, record) => bumpVerifiedAt(source, record.id, today),
      readFileSync(config.file, 'utf8'),
    )
    writeFileSync(config.file, next)
    console.log(`wrote verifiedAt ${today} in ${config.file}`)
  }
}

async function runChatProbe(probe: ChatCompletionsProbe): Promise<void> {
  const planned = probe.models.length * PROBE_CHECKS.length
  if (planned > MAX_PROBE_REQUESTS) {
    console.error(
      `probe: ${probe.provider} plans ${planned} requests, over the per-run cap of ${MAX_PROBE_REQUESTS}. Shorten its model list.`,
    )
    process.exit(1)
  }
  const apiKey = readKey(probe.keyEnv)
  const ranBy =
    process.env.TANSTACK_SOURCE_JOB_ID || process.env.CI
      ? 'weekly-probe'
      : userInfo().username
  const found: Array<ProbedFactRecord> = []
  let sent = 0
  for (const model of probe.models) {
    for (const check of PROBE_CHECKS) {
      // Belt and braces: the plan above already bounds this.
      if (++sent > MAX_PROBE_REQUESTS) throw new Error('probe: request cap hit')
      const body = probeBody(check, model)
      const { status, text } = await send(probe.url, body, apiKey)
      const outcome = classifyProbeResponse(check, status, text)
      const label = `${model} ${check}`
      if ('undecided' in outcome) {
        console.log(
          `${label}: undecided (${redact(outcome.undecided, apiKey)})`,
        )
        continue
      }
      console.log(`${label}: ${outcome.fact} = ${String(outcome.value)}`)
      found.push({
        id: `${model}:${outcome.fact}`,
        provider: probe.provider,
        model,
        fact: outcome.fact,
        value: outcome.value,
        route: probe.route,
        verifiedAt: today,
        ranBy,
        request: { url: probe.url, body },
        evidence: { status, message: redact(outcome.message, apiKey) },
      })
    }
  }
  if (!write) return
  // An undecided check keeps its stored record; a decided one replaces it.
  // The same value is re-dated only once the record nears stale, so a
  // weekly run with nothing new changes no file.
  const stored = new Map(
    probedFactRecords.map((record) => [record.id, record] as const),
  )
  for (const [index, record] of found.entries()) {
    const prior = stored.get(record.id)
    if (
      prior &&
      prior.value === record.value &&
      probeAgeDays(prior.verifiedAt, new Date()) <= REDATE_AFTER_DAYS
    ) {
      found[index] = prior
    }
  }
  const ids = new Set(found.map((record) => record.id))
  const kept = probedFactRecords.filter(
    (record) => record.provider === probe.provider && !ids.has(record.id),
  )
  const records = [...kept, ...found].sort((a, b) => a.id.localeCompare(b.id))
  const file = probedFactFile(probe.provider)
  writeFileSync(
    file,
    `// Written by \`pnpm run probe -- ${probe.provider} --write\`. Do not edit by hand.\nimport type { ProbedFactRecord } from '../types.ts'\n\nexport const records: Array<ProbedFactRecord> = ${JSON.stringify(records, null, 2)}\n`,
  )
  const format = spawnSync('pnpm', ['exec', 'oxfmt', file], {
    stdio: 'inherit',
  })
  if (format.status !== 0) throw new Error(`probe: oxfmt failed on ${file}`)
  console.log(`wrote ${records.length} records to ${file}`)
}

/** A 2xx body is cancelled unread: it states nothing, and it bills. */
async function send(
  url: string,
  body: Record<string, unknown>,
  secret: string,
): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'user-agent': 'modelschemas-probe/1',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.ok) {
      await response.body?.cancel()
      return { status: response.status, text: '' }
    }
    return { status: response.status, text: await response.text() }
  } catch {
    // The error can quote the request; report only that it failed.
    return { status: 0, text: '' }
  }
}

function redact(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, '[key]') : text
}

function readKey(keyEnv: string): string {
  const fromEnv = process.env[keyEnv]?.trim()
  if (fromEnv) return fromEnv
  if (skipMissingKey) {
    console.log(`skip ${providerId}: ${keyEnv} is not set`)
    process.exit(0)
  }
  const result = spawnSync(
    'doppler',
    [
      'secrets',
      'get',
      keyEnv,
      '--project',
      'modelschemas',
      '--config',
      'dev',
      '--plain',
    ],
    { encoding: 'utf8' },
  )
  const value = result.error ? '' : result.stdout.trim()
  if (result.status !== 0 || value.length === 0) {
    console.error(
      `${keyEnv} is missing from the environment and from Doppler dev.`,
    )
    const detail = result.error ? result.error.message : result.stderr.trim()
    if (detail) console.error(detail)
    process.exit(1)
  }
  return value
}

function headersFor(
  record: ProbeRecord,
  keyEnv: string,
  secret: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record.request.headers)) {
    headers[name] = value.replaceAll(`$${keyEnv}`, secret)
  }
  return headers
}

async function runRecord(
  record: ProbeRecord,
  config: { origin: string; keyEnv: string },
  secret: string,
): Promise<string | null> {
  const response = await fetch(`${config.origin}${record.request.path}`, {
    method: record.request.method,
    headers: headersFor(record, config.keyEnv, secret),
    body: JSON.stringify(record.request.body),
  })
  const text = await response.text()
  const payloads = record.expect.sse ? ssePayloads(text) : [parseJson(text)]
  return observationMatches(record.expect, {
    status: response.status,
    payloads: payloads.filter((payload) => payload !== undefined),
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function ssePayloads(text: string): Array<unknown> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => parseJson(line.slice('data:'.length).trim()))
    .filter((payload) => payload !== undefined)
}
