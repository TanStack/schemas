// Read-only local dry run of the live probes. Spends a key and calls the
// provider; writes nothing (no file, no D1). Never prints the key.
//
//   pnpm run probe -- <provider> <rawId> [rawId...]   chat probe (#717)
//   pnpm run probe -- opencode-go                     legacy route records
//
// Chat probe: prints what each check would observe, decided or not. The
// Worker's probe cron is what records observations (probe_observations);
// nothing here can. Route records: prints whether each still matches.
import { spawnSync } from 'node:child_process'

import {
  classifyProbeResponse,
  probeBody,
  probeChecks,
  redactKey,
  sendProbe,
} from '../src/server/providers/probes/chat-completions.ts'
import type { ChatCompletionsProbe } from '../src/server/providers/probes/chat-completions.ts'
import { observationMatches } from '../src/server/providers/probes/compare.ts'
import {
  chatProbeFor,
  chatProbes,
  probesFor,
} from '../src/server/providers/probes/index.ts'
import type { ProbeRecord } from '../src/server/providers/probes/types.ts'

/** Local cap: a dry run never sends more than this many requests. */
const MAX_DRY_RUN_REQUESTS = 12

const ROUTE_PROBES: Record<string, { origin: string; keyEnv: string }> = {
  'opencode-go': {
    origin: 'https://opencode.ai',
    keyEnv: 'OPENCODE_GO_API_KEY',
  },
}

// pnpm 11 passes the `--` through.
const args = process.argv.slice(2).filter((arg) => arg !== '--')
const [providerId, ...modelIds] = args
const chat = providerId ? chatProbeFor(providerId) : null
const known = [
  ...Object.keys(ROUTE_PROBES),
  ...chatProbes.filter((probe) => !probe.gateway).map((p) => p.provider),
]
if (!providerId || !known.includes(providerId)) {
  console.error(
    `usage: pnpm run probe -- <provider> [rawId...]\nproviders: ${known.join(', ')}`,
  )
  process.exit(1)
}

if (chat) await dryRunChat(chat, modelIds)
else await checkRouteRecords()

async function dryRunChat(
  probe: ChatCompletionsProbe,
  ids: Array<string>,
): Promise<void> {
  const checks = probeChecks(probe)
  if (ids.length === 0) {
    console.error('name at least one raw model id to probe')
    process.exit(1)
  }
  if (ids.length * checks.length > MAX_DRY_RUN_REQUESTS) {
    console.error(
      `would send ${ids.length * checks.length} requests, over the cap of ${MAX_DRY_RUN_REQUESTS}`,
    )
    process.exit(1)
  }
  const key = readKey(probe.keyEnv)
  for (const model of ids) {
    for (const check of checks) {
      const { status, text } = await sendProbe(
        probe.url,
        probeBody(check, model),
        key,
      )
      const outcome = classifyProbeResponse(
        check,
        status,
        text,
        probe.mandatoryRule,
      )
      const said =
        'undecided' in outcome
          ? `undecided (${outcome.undecided})`
          : `${outcome.fact} = ${String(outcome.value)} (${outcome.message})`
      console.log(`${model} ${check}: ${redactKey(said, key)}`)
    }
  }
  console.log('dry run: nothing written')
}

async function checkRouteRecords(): Promise<void> {
  const config = ROUTE_PROBES[providerId!]!
  const key = readKey(config.keyEnv)
  let failed = false
  for (const record of probesFor(providerId!)) {
    const mismatch = await runRecord(record, config, key)
    if (mismatch) failed = true
    console.log(`${record.id}: ${mismatch ?? 'match'}`)
  }
  if (failed) process.exit(1)
}

function readKey(keyEnv: string): string {
  const fromEnv = process.env[keyEnv]?.trim()
  if (fromEnv) return fromEnv
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
    process.exit(1)
  }
  return value
}

async function runRecord(
  record: ProbeRecord,
  config: { origin: string; keyEnv: string },
  secret: string,
): Promise<string | null> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record.request.headers)) {
    headers[name] = value.replaceAll(`$${config.keyEnv}`, secret)
  }
  const response = await fetch(`${config.origin}${record.request.path}`, {
    method: record.request.method,
    headers,
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
