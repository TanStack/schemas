/** Native OpenCode routes, with unpublished request/response schemas absent. */
import { markdownSection, markdownTableRows } from './model-facts.ts'
import {
  goListingRoutes,
  OPENCODE_GO_MODELS_URL,
  openCodeGoHeaderParameters,
} from './opencode-go-facts.ts'
import { probesFor } from './probes/index.ts'
import { fetchText, PROVENANCE_MARKER, sha256Text } from './types.ts'
import type {
  OpenApiDocument,
  OpenApiOperation,
  SpecFetchResult,
} from './types.ts'

export const ROUTE_ONLY_MARKER = 'x-modelschemas-route-only'
const ROUTE_ACTIVITY = 'x-modelschemas-opencode-activity'
const DOCS_ROOT =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/services/site/src/docs/content/console/'
/** Source of https://opencode.ai/docs/console/api/inference/: Zen's Endpoints table. */
export const OPENCODE_ROUTE_DOCS_URL = `${DOCS_ROOT}api/inference.mdx`
const ORIGIN = 'https://opencode.ai'

interface RouteRow {
  schemaEndpointId?: string | null
  activity?: string | null
}

/** Paths the page's `## Endpoints` table lists. Throws when it lists none. */
export function documentedRoutes(text: string, url: string): Array<string> {
  const routes: Array<string> = []
  for (const cells of markdownTableRows(markdownSection(text, 'Endpoints'))) {
    for (const cell of cells) {
      const code = /^`([^`]+)`$/.exec(cell)?.[1] ?? ''
      const path = code.startsWith(ORIGIN) ? code.slice(ORIGIN.length) : code
      if (path.startsWith('/inference/')) routes.push(path)
    }
  }
  if (routes.length === 0)
    throw new Error(`opencode: ${url} documents no endpoint paths`)
  return routes
}

/** Go routes from a models-list body. */
function listingRoutes(text: string, url: string): Array<string> {
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error(`opencode-go: ${url} is not JSON`)
  }
  return goListingRoutes(payload)
}

/** A documented path as a matcher for a stored path. A `<placeholder>` matches one path segment. */
function routePattern(documented: string): RegExp {
  const escaped = documented.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/<[^>]+>/g, '[^/:]+')}$`)
}

/**
 * A probed route stays route-only. The live call shows the method and a
 * response shape; it does not publish the request schema.
 */
export function probeOperation(record: {
  verifiedAt: string
  route: string
}): OpenApiOperation {
  return {
    [ROUTE_ONLY_MARKER]: true,
    [ROUTE_ACTIVITY]: 'chat',
    [PROVENANCE_MARKER]: {
      derivation: 'probe-verified',
      verifiedAt: record.verifiedAt,
    },
    'x-modelschemas-probe': record.route,
    responses: {},
  }
}

export async function openCodeRouteSpec(
  rows: Array<RouteRow>,
  docs: { url: string; text?: string; hash?: string },
  go: boolean,
): Promise<SpecFetchResult> {
  const routes = rows.flatMap((row) =>
    row.schemaEndpointId && row.activity === 'chat'
      ? [`/${row.schemaEndpointId.replace(/^\//, '')}`]
      : [],
  )
  const provider = go ? 'opencode-go' : 'opencode'
  const probed = new Map(
    probesFor(provider).map((record) => [`/${record.route}`, record]),
  )
  for (const path of probed.keys()) {
    if (!routes.includes(path)) routes.push(path)
  }
  if (routes.length === 0)
    throw new Error('opencode: catalog names no verified chat routes')
  // Zen still publishes an Endpoints table. Go's page points at the models
  // list: each row's `api.<protocol>.base_url` is the route (issue #679).
  const url = go ? OPENCODE_GO_MODELS_URL : OPENCODE_ROUTE_DOCS_URL
  const text = await fetchText(url, { signal: AbortSignal.timeout(30_000) })
  const stated = go ? listingRoutes(text, url) : documentedRoutes(text, url)
  const documented = stated.map(routePattern)
  // Hash the route list, not the whole models payload. Cost, limits, and
  // capabilities ride on the same rows and are not part of this document.
  const method = {
    url,
    hash: await sha256Text(go ? stated.join('\n') : text),
  }
  const headers = go ? openCodeGoHeaderParameters() : undefined
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const path of routes) {
    const record = probed.get(path)
    if (record) {
      paths[path] = {
        post: { ...probeOperation(record), parameters: headers },
      }
      continue
    }
    if (!documented.some((pattern) => pattern.test(path))) {
      const verb = go ? 'states' : 'documents'
      const tag = go ? 'opencode-go' : 'opencode'
      throw new Error(`${tag}: ${url} ${verb} no ${path} route`)
    }
    paths[path] = {
      post: {
        [ROUTE_ONLY_MARKER]: true,
        [ROUTE_ACTIVITY]: 'chat',
        'x-modelschemas-method-source': method,
        ...(headers ? { parameters: headers } : {}),
        responses: {},
      },
    }
  }
  const hash =
    docs.hash ?? (docs.text !== undefined ? await sha256Text(docs.text) : null)
  if (!hash) throw new Error('opencode: route spec has no catalog source')
  return {
    specs: [{ openapi: '3.1.0', paths }],
    sources: [{ url: docs.url, hash }],
    outputStrategy: 'post-200',
  }
}

export function classifyOpenCodeRoute(
  _path: string,
  operation: Record<string, unknown>,
): 'chat' | null {
  return operation[ROUTE_ONLY_MARKER] === true &&
    operation[ROUTE_ACTIVITY] === 'chat'
    ? 'chat'
    : null
}
