import { bearerConnect } from '../connect.ts'
import {
  OPENCODE_GO_MODELS_URL,
  OPENCODE_GO_REQUIRED_HEADERS,
  goTrainsOnRequestData,
} from '../opencode-go-facts.ts'
import { classifyOpenCodeRoute, openCodeRouteSpec } from '../opencode-routes.ts'
/** OpenCode Go: live ids and catalog routes. Subscription prices stay null. */
import {
  loadOpenCodeCatalog,
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from '../opencode-catalog.ts'
import { fetchJson } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { parseOpencodeModels } from './opencode.ts'

export { OPENCODE_GO_MODELS_URL }

const FETCH_TIMEOUT_MS = 30_000

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const [payload, loaded] = await Promise.all([
    fetchJson(OPENCODE_GO_MODELS_URL, { signal }),
    loadOpenCodeCatalog(kv),
  ])
  const training = goTrainsOnRequestData(payload)
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode-go',
    loaded.hash,
  )
  const models = parseOpencodeModels(payload, 'opencode-go').map(
    (model): ModelInfo => {
      const facts = catalog[model.rawId]
      const stated = training.get(model.rawId)
      if (stated === undefined) {
        throw new Error(
          `opencode-go: ${model.rawId} has no go.training boolean`,
        )
      }
      // A stated no is stored as null, the same as the old "Not used" cell.
      const trainsOnRequestData = stated ? true : null
      const factSources = stated
        ? {
            ...facts?.factSources,
            trainsOnRequestData: {
              derivation: 'listing' as const,
              sourceUrl: OPENCODE_GO_MODELS_URL,
              path: 'go.training',
            },
          }
        : facts?.factSources
      const absent =
        facts?.releasedAt == null
          ? { releasedAt: 'cleared' as const }
          : undefined
      if (!facts) {
        return {
          ...model,
          trainsOnRequestData,
          ...(factSources ? { factSources } : {}),
          absent,
        }
      }
      return {
        ...model,
        ...facts,
        trainsOnRequestData,
        // models.dev `cost` is left unread: it is not a confirmed billed price.
        pricing: null,
        ...(factSources ? { factSources } : {}),
        ...(absent ? { absent } : {}),
      }
    },
  )
  if (!models.some((model) => model.activity === 'chat')) {
    throw new Error('opencode-go: catalog classified 0 listed models')
  }
  return { models }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const loaded = await loadOpenCodeCatalog()
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode-go',
    loaded.hash,
  )
  return openCodeRouteSpec(
    Object.values(catalog),
    { url: OPENCODE_CATALOG_URL, hash: loaded.hash },
    true,
  )
}

export const provider: ProviderConfig = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  specSourceUrl: OPENCODE_CATALOG_URL,
  modelsEndpoint: OPENCODE_GO_MODELS_URL,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  bindStoredRoutesWithoutSchemas: true,
  connect: {
    ...bearerConnect('https://opencode.ai', 'OpenCode Go'),
    requiredHeaders: OPENCODE_GO_REQUIRED_HEADERS,
  },
  fetchSpec,
  listModels,
  classify: classifyOpenCodeRoute,
}
