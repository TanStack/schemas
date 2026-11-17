/**
 * Facts OpenCode publishes for every Go request, plus training on request
 * data. The live models list states it as `go.training` (issue #675). A
 * probe record still states it for an id the list does not mention.
 */
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
