/**
 * Google-hosted Claude: dynamically read Google's linked model cards and prices.
 * The request page states the `:rawPredict` route for any Claude model id
 * but publishes examples, not a body schema, so that route is stored
 * route-only (issue #716).
 */
import {
  beginGoogleDocsPoll,
  cachedGoogleDocs,
  googleDocsFailures,
} from '../google-docs.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import { classifyOpenCodeRoute, routeOnlyChatSpec } from '../opencode-routes.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { fetchText, sha256Text } from '../types.ts'
import {
  VERTEX_CLAUDE_URL,
  VERTEX_CLAUDE_REQUEST_URL,
  vertexClaudeModels,
  vertexClaudeRoute,
} from '../vertex-claude.ts'

async function loadRoute(): Promise<{ route: string; hash: string }> {
  const html = await fetchText(VERTEX_CLAUDE_REQUEST_URL)
  return { route: vertexClaudeRoute(html), hash: await sha256Text(html) }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { route, hash } = await loadRoute()
  return routeOnlyChatSpec([route], { url: VERTEX_CLAUDE_REQUEST_URL, hash })
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  beginGoogleDocsPoll()
  const models = await vertexClaudeModels(kv)
  const run = docsRun()
  const stated = await tryDocs(run, VERTEX_CLAUDE_REQUEST_URL, () =>
    cachedGoogleDocs(kv, `${VERTEX_CLAUDE_REQUEST_URL}#route`, loadRoute),
  )
  const google = googleDocsFailures()
  const own = docsReport(run)
  return {
    models: models.map((model) =>
      stated
        ? {
            ...model,
            schemaEndpointId: stated.route,
            factSources: {
              ...model.factSources,
              schemaEndpointId: {
                derivation: 'docs-derived',
                sourceUrl: VERTEX_CLAUDE_REQUEST_URL,
                sourceHash: stated.hash,
                path: 'HTTP method and URL',
              },
            },
          }
        : {
            ...model,
            absent: { ...model.absent, schemaEndpointId: 'unavailable' },
          },
    ),
    docsFailures: {
      failed: google.failed + own.failed,
      skipped: google.skipped + own.skipped,
      first: [...google.first, ...own.first],
    },
  }
}

export const provider: ProviderConfig = {
  id: 'google-vertex-anthropic',
  // LLM Gateway route name (providers[].providerId).
  modelNamespaces: ['vertex-anthropic'],
  // The catalog is "Anthropic's Claude on Google Cloud models", and each
  // card's Model ID is Anthropic's id; an id with no Anthropic row stays
  // unlinked.
  upstreamModelIdentity: (rawId) => ({
    providerNamespace: 'anthropic',
    rawId,
    source: {
      derivation: 'docs-derived',
      sourceUrl: VERTEX_CLAUDE_URL,
      path: 'Model ID',
    },
  }),
  displayName: 'Vertex (Anthropic)',
  specSourceUrl: VERTEX_CLAUDE_REQUEST_URL,
  modelsEndpoint: VERTEX_CLAUDE_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  bindSyncedRoutesOnly: true,
  bindStoredRoutesWithoutSchemas: true,
  classify: classifyOpenCodeRoute,
}
