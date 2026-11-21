/**
 * Mistral — public OpenAPI 3.1 at docs.mistral.ai/openapi.yaml.
 * Models listing requires MISTRAL_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import {
  MISTRAL_DEPRECATIONS_URL,
  loadDeprecations,
  parseMistralDeprecations,
} from '../deprecations.ts'
import { docsReport, docsRun, tryDocs, unavailable } from '../model-facts.ts'
import {
  mistralGenerationEndpointId,
  mistralModelActivity,
} from '../model-meta.ts'
import {
  MISTRAL_PRICING_URL,
  copyMistralAliasFacts,
  mistralModelPricing,
  parseMistralMakers,
} from '../mistral-pricing.ts'
import {
  MISTRAL_OPENAPI_URL,
  mistralChatWire,
  mistralRequestMap,
} from '../mistral-request.ts'
import {
  MISTRAL_REASONING_URL,
  listsReasoning,
  mistralModelReasoning,
  overlayModelFacts,
} from '../reasoning-config.ts'
import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import { bearerConnect } from '../connect.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import type { OpenAiCompatModelRow } from '../openai-compat.ts'

const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models'

/**
 * Generation surface only. Chat/fim/agents-completions are chat;
 * classifiers that are not moderation, OCR, conversations CRUD, files,
 * fine-tune, batch, and admin classify to null.
 */
function classify(path: string): Activity | null {
  const bare = path.includes('#') ? path.slice(0, path.indexOf('#')) : path
  if (
    bare === '/v1/chat/completions' ||
    bare === '/v1/fim/completions' ||
    bare === '/v1/agents/completions'
  ) {
    return 'chat'
  }
  if (bare === '/v1/embeddings') return 'embeddings'
  if (bare === '/v1/moderations' || bare === '/v1/chat/moderations') {
    return 'moderation'
  }
  if (bare === '/v1/audio/speech' || bare === '/v1/audio/transcriptions') {
    return 'audio'
  }
  return null
}

/**
 * A page we read that names no price clears a stored card. Mutual aliases
 * of that page clear too, unless one of them has a price.
 */
function clearUnpriced(
  models: Array<ModelInfo>,
  seen: ReadonlySet<string>,
  aliases: ReadonlyMap<string, ReadonlyArray<string>>,
): void {
  const byId = new Map(models.map((model) => [model.rawId, model]))
  const clear = (model: ModelInfo | undefined) => {
    if (!model || model.pricing != null) return
    model.absent = { ...model.absent, pricing: 'cleared' }
  }
  for (const model of models) {
    if (seen.has(model.rawId)) clear(model)
  }
  for (const [id, names] of aliases) {
    const clique = [id, ...names].filter(
      (other) =>
        byId.has(other) && (other === id || aliases.get(other)?.includes(id)),
    )
    if (!clique.some((other) => seen.has(other))) continue
    if (clique.some((other) => byId.get(other)?.pricing != null)) continue
    for (const other of clique) clear(byId.get(other))
  }
}

/**
 * Alias links a listing row states (issue #709). Every member of an alias
 * group lists the others in `aliases`: membership is stated. Which id the
 * others resolve to is not (the listing's `name` is an undescribed display
 * string), so every grouped row says its target is unstated.
 */
export function mistralAliasFacts(
  row: Pick<OpenAiCompatModelRow, 'id' | 'aliases'>,
): Partial<ModelInfo> {
  const aliases = (row.aliases ?? []).filter(
    (id) => typeof id === 'string' && id.length > 0 && id !== row.id,
  )
  if (aliases.length === 0) return {}
  const source = (path: string): FactSource => ({
    derivation: 'listing',
    sourceUrl: MISTRAL_MODELS_URL,
    path,
  })
  return {
    aliases,
    aliasOf: null,
    factSources: { aliases: source('aliases'), aliasOf: source('unstated') },
  }
}

/** The models overview, cached apart from its deprecations parse. */
const MISTRAL_MAKERS_KEY = `${MISTRAL_DEPRECATIONS_URL}#makers`

/**
 * The maker an overview Summary names for this id. `unstated` only when
 * the overview's API name column lists the id, or a mutual listing alias
 * of it, and no Summary in that group names a maker (Mistral's own
 * models). An alias of a third-party row is left for
 * `copyMistralAliasFacts`. An id the overview never lists gets nothing:
 * absence from the table is not a statement.
 */
export function mistralMakerFacts(
  rawId: string,
  makers: { byId: Record<string, string>; named: Array<string>; hash: string },
  mutualAliases: ReadonlyArray<string> = [],
): Partial<ModelInfo> {
  const maker = makers.byId[rawId] ?? null
  if (maker === null && !makers.named.includes(rawId)) {
    const listed = mutualAliases.filter((id) => makers.named.includes(id))
    if (listed.length === 0 || listed.some((id) => id in makers.byId)) {
      return {}
    }
  }
  return {
    maker,
    factSources: {
      maker: {
        derivation: 'docs-derived',
        sourceUrl: MISTRAL_DEPRECATIONS_URL,
        sourceHash: makers.hash,
        path: maker === null ? 'unstated' : 'Summary',
      },
    },
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(MISTRAL_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: MISTRAL_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'mistral',
  makesOwnModels: true,
  displayName: 'Mistral',
  authEnvVar: 'MISTRAL_API_KEY',
  specSourceUrl: MISTRAL_OPENAPI_URL,
  modelsEndpoint: MISTRAL_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect('https://api.mistral.ai'),
  fetchSpec,
  listModels: async (env, kv): Promise<ListModelsResult> => {
    const aliases = new Map<string, Array<string>>()
    const listed = await listOpenAiCompatibleModels({
      providerId: 'mistral',
      url: MISTRAL_MODELS_URL,
      env,
      envVar: 'MISTRAL_API_KEY',
      activity: mistralModelActivity,
      extend: (row) => {
        const names = row.aliases?.filter(
          (id) => typeof id === 'string' && id.length > 0,
        )
        if (names && names.length > 0) aliases.set(row.id, names)
        // `created` is the request time on every row, not a release date
        // (#708). The date comes from the model page's markdown twin.
        return Promise.resolve({ releasedAt: null, ...mistralAliasFacts(row) })
      },
    })
    if (listed.models.length === 0) return listed
    const chat = listed.models.some((model) => model.activity === 'chat')
    const docs = docsRun()
    const deprecations = await loadDeprecations(
      docs,
      kv,
      MISTRAL_DEPRECATIONS_URL,
      parseMistralDeprecations,
    )
    // The pricing load reads the pricing table, changelog, models index,
    // model pages and web search guide; a failing docs page keeps the
    // stored facts instead of failing the poll.
    const [pricing, reasoning, wire, makers] = await Promise.all([
      tryDocs(docs, MISTRAL_PRICING_URL, (cached) =>
        mistralModelPricing(
          kv,
          listed.models.map((model) => model.rawId),
          cached,
        ),
      ),
      tryDocs(docs, MISTRAL_REASONING_URL, (cached) =>
        mistralModelReasoning(kv, cached),
      ),
      chat ? mistralChatWire(kv) : Promise.resolve(null),
      tryDocs(docs, MISTRAL_MAKERS_KEY, (cached) =>
        cached(kv, MISTRAL_MAKERS_KEY, async () => {
          const markdown = await fetchText(MISTRAL_DEPRECATIONS_URL)
          const { makers: byId, named } = parseMistralMakers(markdown)
          return {
            byId: Object.fromEntries(byId),
            named: [...named],
            hash: await sha256Text(markdown),
          }
        }),
      ),
    ])
    const models = listed.models.map((model) =>
      overlayModelFacts(
        model,
        pricing
          ? pricing(model.rawId)
          : unavailable('pricing', 'serverTools', 'modalities', 'maxOutput'),
        reasoning
          ? reasoning(model.rawId, listsReasoning(model.capabilities))
          : unavailable('reasoning'),
        makers
          ? mistralMakerFacts(
              model.rawId,
              makers,
              (aliases.get(model.rawId) ?? []).filter((id) =>
                aliases.get(id)?.includes(model.rawId),
              ),
            )
          : unavailable('maker'),
      ),
    )
    copyMistralAliasFacts(models, aliases)
    if (wire) {
      for (const model of models) {
        if (model.activity !== 'chat') continue
        // The thinking request comes from the reasoning facts; keep the
        // stored map whole rather than write one built without them.
        if (!reasoning) {
          model.absent = { ...model.absent, requestMap: 'unavailable' }
          continue
        }
        model.requestMap = mistralRequestMap(wire, model.reasoning)
        model.factSources = {
          ...model.factSources,
          requestMap: {
            derivation: 'docs-derived',
            sourceUrl: MISTRAL_OPENAPI_URL,
            sourceHash: wire.hash,
            path: '/components/schemas/ChatCompletionRequest',
          },
        }
      }
    }
    if (pricing) clearUnpriced(models, pricing.seen, aliases)
    return {
      ...listed,
      models,
      ...(deprecations ? { deprecations } : {}),
      docsFailures: docsReport(docs),
    }
  },
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    mistralGenerationEndpointId(rawId, activity),
}
