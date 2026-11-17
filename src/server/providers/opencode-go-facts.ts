/**
 * Facts OpenCode publishes for every Go request, plus training on request
 * data. The live models list states it as `go.training` (issue #675). The
 * Go docs privacy table used to (issue #463) and now states retention only;
 * its notes still name the models that train. A probe record still states
 * it for an id the list does not mention.
 */
import { markdownSection, markdownTableRows } from './model-facts.ts'
import { requiredHeaderParameters } from './connect.ts'
import { probesFor } from './probes/index.ts'
import type { FactSource, ModelFactSources, RequiredHeader } from './types.ts'

/** https://opencode.ai/docs/console/go/ (`/docs/go/` 301s here). */
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/console/go/'

export const OPENCODE_GO_REQUIRED_HEADERS: Array<RequiredHeader> = [
  {
    name: 'x-opencode-session',
    description:
      'A stable session id the client chooses for each conversation.',
  },
  {
    name: 'User-Agent',
    description:
      'A client-specific User-Agent, such as my-coding-agent/1.0, not a generic SDK or HTTP-library name.',
  },
]

/** OpenAPI header parameters for every Go operation. Values are not constants. */
export function openCodeGoHeaderParameters(): Array<Record<string, unknown>> {
  return requiredHeaderParameters(OPENCODE_GO_REQUIRED_HEADERS).map(
    (parameter) => ({
      ...parameter,
      description: `${String(parameter.description)} ${OPENCODE_GO_DOCS_URL}`,
    }),
  )
}

const HEADER_SOURCE: FactSource = {
  derivation: 'docs-derived',
  sourceUrl: OPENCODE_GO_DOCS_URL,
  path: 'Where can I use it?',
}

function cellId(cell: string | undefined): string {
  return (cell ?? '').replace(/^`|`$/g, '').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `go.training` on each id of `GET /v1/models` for Go. That boolean is what
 * https://opencode.ai/console/go#privacy shows. `true` trains. `false` is a
 * stated no. Throws when a listed id has no boolean: a missing field is an
 * unknown shape, not an unstated fact.
 */
export function goTrainsOnRequestData(payload: unknown): Map<string, boolean> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('opencode-go: models payload has no data array')
  }
  const training = new Map<string, boolean>()
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const go = row.go
    if (!isRecord(go) || typeof go.training !== 'boolean') {
      throw new Error(`opencode-go: ${row.id} has no go.training boolean`)
    }
    training.set(row.id, go.training)
  }
  if (training.size === 0) {
    throw new Error('opencode-go: models payload listed no ids')
  }
  return training
}

const RETENTION_CELL = /^(?:\d+ days(?:\*)?|Not ZDR)$/
const TRAINS_ON_REQUESTS =
  /permission to use your prompts and completions to (?:train\b|improve the model)/i

function endpointIds(text: string): Map<string, string> {
  const endpoints = markdownSection(text, 'Endpoints')
  if (endpoints === '') {
    throw new Error('opencode-go: go docs have no Endpoints or Privacy section')
  }
  const ids = new Map<string, string>()
  for (const cells of markdownTableRows(endpoints)) {
    if (cells[0] === 'Model') continue
    const name = cells[0]
    const id = cellId(cells[1])
    if (!name || id === '') continue
    ids.set(name, id)
  }
  return ids
}

function idFor(ids: Map<string, string>, name: string): string {
  const id = ids.get(name)
  if (!id) {
    throw new Error(`opencode-go: privacy model ${name} has no endpoint id`)
  }
  return id
}

/** A privacy note that states training, or false when it states none. */
function noteTrains(body: string): boolean {
  if (TRAINS_ON_REQUESTS.test(body)) return true
  if (
    /\btrain(?:s|ing|ed)?\b/i.test(body) ||
    /\bimprove the model\b/i.test(body)
  ) {
    throw new Error(
      `opencode-go: privacy note states training in an unknown way: ${body.slice(0, 120)}`,
    )
  }
  return false
}

/**
 * Privacy table joined to the Endpoints table on the model name.
 * A "Model training" column: `true` is "Yes", `false` is "Not used".
 * A "Data retention" column does not state training. `true` is only a
 * note that says the model may use prompts and completions to train or
 * improve the model. Other rows are left out (unstated). A retention
 * period is not a no. Throws when a section, a row, a cell, or a note
 * is not a shape the page publishes.
 */
export function parseGoTraining(text: string): Map<string, boolean> {
  const privacy = markdownSection(text, 'Privacy')
  if (privacy === '') {
    throw new Error('opencode-go: go docs have no Endpoints or Privacy section')
  }
  const rows = markdownTableRows(privacy)
  const header = rows[0]
  if (header?.[0] !== 'Model') {
    throw new Error('opencode-go: privacy table has no Model column')
  }
  const trainingCol = header.indexOf('Model training')
  const retentionCol = header.indexOf('Data retention')
  if (trainingCol < 0 && retentionCol < 0) {
    throw new Error(
      'opencode-go: privacy table has no training or retention column',
    )
  }
  const ids = endpointIds(text)
  const training = new Map<string, boolean>()
  if (trainingCol >= 0) {
    for (const cells of rows) {
      if (cells[0] === 'Model') continue
      const name = cells[0]
      const stated = cells[trainingCol]
      if (!name) continue
      if (stated !== 'Yes' && stated !== 'Not used') {
        throw new Error(
          `opencode-go: privacy training cell ${JSON.stringify(stated)} for ${name}`,
        )
      }
      training.set(idFor(ids, name), stated === 'Yes')
    }
    if (training.size === 0) {
      throw new Error('opencode-go: privacy table names no models')
    }
    return training
  }
  const named = new Set<string>()
  for (const cells of rows) {
    if (cells[0] === 'Model') continue
    const name = cells[0]
    if (!name) continue
    const stated = cells[retentionCol]
    if (!stated || !RETENTION_CELL.test(stated)) {
      throw new Error(
        `opencode-go: privacy retention cell ${JSON.stringify(stated)} for ${name}`,
      )
    }
    named.add(name)
  }
  if (named.size === 0) {
    throw new Error('opencode-go: privacy table names no models')
  }
  for (const match of privacy.matchAll(/^- \*\*([^*]+):\*\* (.*)$/gm)) {
    const body = match[2] ?? ''
    if (!noteTrains(body)) continue
    for (const name of (match[1] ?? '')
      .split(' / ')
      .map((part) => part.trim())) {
      if (!named.has(name)) {
        throw new Error(
          `opencode-go: privacy note names ${name}, missing from the table`,
        )
      }
      training.set(idFor(ids, name), true)
    }
  }
  return training
}

export function openCodeGoFacts(
  providerId: string,
  rawId: string,
): {
  requiredRequestHeaders: Array<RequiredHeader> | null
  trainsOnRequestData: boolean | null
  factSources: Pick<
    ModelFactSources,
    'requiredRequestHeaders' | 'trainsOnRequestData'
  >
} {
  if (providerId !== 'opencode-go') {
    return {
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    }
  }
  const training = probesFor(providerId).find(
    (record) => record.model === rawId && record.trainsOnRequestData === true,
  )
  return {
    requiredRequestHeaders: OPENCODE_GO_REQUIRED_HEADERS,
    trainsOnRequestData: training ? true : null,
    factSources: {
      requiredRequestHeaders: HEADER_SOURCE,
      ...(training
        ? {
            trainsOnRequestData: {
              derivation: 'probe-verified' as const,
              verifiedAt: training.verifiedAt,
              sourceUrl: `src/server/providers/probes/opencode-go.ts#${training.id}`,
            },
          }
        : {}),
    },
  }
}
