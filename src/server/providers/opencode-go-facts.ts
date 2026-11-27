/**
 * Facts OpenCode publishes for every Go request, plus training on request
 * data. The live models list states it as `go.training` (issue #675). The
 * same list states each route as `api.<protocol>.base_url` (issue #679).
 * A probe record still states training for an id the list does not mention.
 */
import { requiredHeaderParameters } from './connect.ts'
import { probesFor } from './probes/index.ts'
import type { FactSource, ModelFactSources, RequiredHeader } from './types.ts'

/** https://opencode.ai/docs/console/go/ (`/docs/go/` 301s here). */
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/console/go/'

/** Live Go model list. Each row's `api` states that model's route. */
export const OPENCODE_GO_MODELS_URL =
  'https://opencode.ai/inference/go/v1/models'

const OPENCODE_ORIGIN = 'https://opencode.ai'

/**
 * Path under `api.<protocol>.base_url`. `generate-content` is Google's
 * method: the model id is one path segment, the same shape as
 * `:generateContent` on the probe records. `interactions` is Google's
 * Interactions API: `POST {base}/interactions`, and the model id is a
 * request-body field, not a path segment. `systemone` is OpenCode's
 * decision API (`POST {base}/systemone`) and `embeddings` is OpenAI's
 * (`POST {base}/embeddings`); the Go page states both paths (issue #776).
 * OpenCode publishes no request schema for any of these routes, so they
 * stay route-only (`opencode-routes.ts`). A key this map does not name is
 * an unknown shape.
 */
const GO_PROTOCOL_PATH: Record<string, (id: string) => string> = {
  'chat-completions': () => 'chat/completions',
  responses: () => 'responses',
  messages: () => 'messages',
  'generate-content': (id) => {
    if (id.includes('/') || id.includes(':')) {
      throw new Error(`opencode-go: unreadable model id ${id}`)
    }
    return `models/${id}:generateContent`
  },
  interactions: () => 'interactions',
  systemone: () => 'systemone',
  embeddings: () => 'embeddings',
}

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

function goApiPath(id: string, protocol: string, baseUrl: string): string {
  const url = URL.parse(baseUrl)
  const path = url?.pathname.replace(/\/$/, '') ?? ''
  if (
    url?.origin !== OPENCODE_ORIGIN ||
    path.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      `opencode-go: ${id} api.${protocol}.base_url is not an opencode.ai path`,
    )
  }
  const suffix = Object.hasOwn(GO_PROTOCOL_PATH, protocol)
    ? GO_PROTOCOL_PATH[protocol]
    : undefined
  if (!suffix) {
    throw new Error(`opencode-go: ${id} has unknown api protocol ${protocol}`)
  }
  return `${path}/${suffix(id)}`
}

/**
 * Routes `GET /v1/models` states for Go: `api.<protocol>.base_url` plus
 * that protocol's path. Cost, limits, and capabilities on the same row are
 * unread. Throws when a listed id has no `api` entry or an unknown
 * protocol key: a missing field is an unknown shape, not an unstated route.
 */
export function goListingRoutes(payload: unknown): Array<string> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('opencode-go: models payload has no data array')
  }
  const routes: Array<string> = []
  const seen = new Set<string>()
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const api = row.api
    if (!isRecord(api) || Object.keys(api).length === 0) {
      throw new Error(`opencode-go: ${row.id} has no api entry`)
    }
    for (const [protocol, entry] of Object.entries(api)) {
      if (!Object.hasOwn(GO_PROTOCOL_PATH, protocol)) {
        throw new Error(
          `opencode-go: ${row.id} has unknown api protocol ${protocol}`,
        )
      }
      if (!isRecord(entry) || typeof entry.base_url !== 'string') {
        throw new Error(`opencode-go: ${row.id} api.${protocol} is unreadable`)
      }
      const route = goApiPath(row.id, protocol, entry.base_url)
      if (seen.has(route)) continue
      seen.add(route)
      routes.push(route)
    }
  }
  if (routes.length === 0) {
    throw new Error('opencode-go: models payload listed no ids')
  }
  routes.sort()
  return routes
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
