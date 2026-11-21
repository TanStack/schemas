/**
 * Catalog queries (PLAN.md task 4.2): providers, cross-provider model
 * catalog with filters, and single-model detail. Route handlers stay thin —
 * these functions are exercised directly by worker tests.
 */
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { Db } from '#/db/index.ts'
import { models, providers } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { halGet } from '#/server/hal.ts'
import { getProvider } from '#/server/providers/index.ts'
import { resolveSpecGrain } from '#/server/providers/connect.ts'
import type {
  FactSource,
  ModelFactSources,
  SameAsInference,
  SpecGrain,
} from '#/server/providers/types.ts'
import {
  firstParty,
  linkedFromCount,
  loadMakerContext,
} from '#/server/first-party.ts'
import type { MakerContext } from '#/server/first-party.ts'
import {
  factDiscrepancies,
  openRouterJoinIds,
} from '#/server/providers/fact-sources.ts'
import {
  resolveAlias,
  storedAliases,
} from '#/server/providers/provider-aliases.ts'
import { servePricing } from '#/server/rate-card.ts'
import { openCodeGoFacts } from '#/server/providers/opencode-go-facts.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { getServiceStatus } from '#/server/status.ts'
import { sourceSilentEvidenceLedger } from './source-silent.ts'
import { withSourceSilentEvidence } from './source-silent-facts.ts'

export interface ModelFilters {
  activity?: Activity
  provider?: string
  /** A flag the model's capability map states as `true`. */
  capability?: string
  /** Free-text match against id, raw id, and display name. */
  q?: string
  /** Deprecated models are excluded unless set. */
  includeDeprecated?: boolean
  /** Include per-field `factSources` by default; false explicitly omits them. */
  provenance?: boolean
  /** Include the full rate card on list rows (default: compact projection). */
  pricing?: boolean
}

const OPENAPI_CONTENT_TYPE = 'application/openapi+json'

function modelLinks(providerId: string) {
  const openapi = openApiLink(providerId)
  return {
    provider: halGet(`/v1/providers/${providerId}/models`),
    schemas: halGet(`/v1/schemas/${providerId}`),
    ...(openapi ? { openapi } : {}),
  }
}

function openApiLink(providerId: string) {
  const config = getProvider(providerId)
  if (!config?.connect) return undefined
  const grain = resolveSpecGrain(config)
  if (grain === 'model') {
    return halGet(`/v1/openapi/${providerId}{?model,activity}`, {
      contentType: OPENAPI_CONTENT_TYPE,
      example: `/v1/openapi/${providerId}?model=fal-ai/flux/dev`,
    })
  }
  return halGet(`/v1/openapi/${providerId}`, {
    contentType: OPENAPI_CONTENT_TYPE,
  })
}

function specDescriptor(
  providerId: string,
  endpointCount: number,
): { grain: SpecGrain; endpointCount: number } {
  return {
    grain: resolveSpecGrain(getProvider(providerId)),
    endpointCount,
  }
}

type ModelRow = typeof models.$inferSelect

const upstreamModel = alias(models, 'upstream_model')
const rootModel = alias(models, 'root_model')
const aliasTarget = alias(models, 'alias_target')
const catalogSelection = {
  row: models,
  upstream: {
    provider: upstreamModel.providerId,
    rawId: upstreamModel.rawId,
    aliases: upstreamModel.aliases,
  },
  root: { provider: rootModel.providerId, rawId: rootModel.rawId },
  aliasOf: aliasTarget.rawId,
  linkedFrom: linkedFromCount,
}

/**
 * An alias row's stated target, served only while a live row at the same
 * provider has that exact raw id (issue #709). The evidence stays on the
 * row; a target that is gone or not yet listed reads as null.
 */
function aliasTargetOn(row: typeof models) {
  return and(
    eq(aliasTarget.providerId, row.providerId),
    eq(aliasTarget.rawId, row.aliasOf),
    isNull(aliasTarget.deprecatedAt),
  )
}
interface UpstreamRow {
  provider: string
  rawId: string
  aliases: Array<string> | null
}

type LinkMatch = 'published' | 'normalized' | 'inferred' | null

// The stored link is only as fresh as the last reconcile, so it is served
// only while the row's current evidence still names that target. The
// evidence is its provenance: a link with no source, or a source with no
// link, would each read as a claim nobody made.
// A name-inferred link (issue #719) is served with the inference it was
// written with, and only on a row that states no upstream.
function linkMatch(
  row: ModelRow,
  upstream: UpstreamRow | null | undefined,
): LinkMatch {
  const stated = row.upstreamRawId
  if (upstream && stated === null && row.sameAsInference) return 'inferred'
  if (!upstream || stated === null || !row.upstreamSource) return null
  const ids = [upstream.rawId, ...(upstream.aliases ?? [])]
  if (ids.includes(stated)) return 'published'
  return ids.includes(stated.replaceAll('.', '-')) ? 'normalized' : null
}

function sameAsSource(
  row: ModelRow,
  match: Exclude<LinkMatch, null>,
): NonNullable<ModelFactSources['sameAs']> {
  if (match === 'inferred') {
    const inference = row.sameAsInference as SameAsInference
    return { derivation: 'name-inferred', ...inference }
  }
  const source = row.upstreamSource as FactSource
  return match === 'published' ? source : { ...source, normalized: true }
}

function modelFactSources(
  row: ModelRow,
  match: LinkMatch,
  aliasOf: string | null,
  firstPartySource: ModelFactSources['firstParty'],
): ModelFactSources | null {
  const sources = (row.factSources as ModelFactSources | null) ?? null
  // Like sameAs: a stated target that resolves to no live row serves
  // neither the link nor its source. A stated silence is always served.
  let stored = sources
  if (sources?.aliasOf && aliasOf === null) {
    const { aliasOf: target, ...rest } = sources
    if (target.path !== 'unstated')
      stored = Object.keys(rest).length > 0 ? rest : null
  }
  const go = openCodeGoFacts(row.providerId, row.rawId).factSources
  const withGo = Object.keys(go).length === 0 ? stored : { ...stored, ...go }
  // A listing yes is stored on the row and wins over the probe.
  // A probe still fills an id the listing does not name.
  const trainingSource =
    row.trainsOnRequestData === true && stored?.trainsOnRequestData
      ? stored.trainsOnRequestData
      : withGo?.trainsOnRequestData
  const merged =
    trainingSource && withGo
      ? { ...withGo, trainsOnRequestData: trainingSource }
      : withGo
  const out = {
    ...merged,
    ...(match === null ? {} : { sameAs: sameAsSource(row, match) }),
    ...(firstPartySource ? { firstParty: firstPartySource } : {}),
  }
  return Object.keys(out).length > 0 || merged !== null ? out : null
}

function encodeEndpointId(endpointId: string): string {
  return endpointId.split('/').map(encodeURIComponent).join('/')
}

function toApiModel(
  row: ModelRow,
  opts: {
    includeFactSources?: boolean
    pricing?: 'compact' | 'full'
    upstream?: UpstreamRow | null
    /** The end of the sameAs chain when it is more than one hop away. */
    root?: { provider: string; rawId: string } | null
    /** The live target of `row.aliasOf`, resolved by the query. */
    aliasOf?: string | null
    /** Rows whose sameAs chain ends at this row. */
    linkedFrom?: number
    makers?: MakerContext
  } = {},
) {
  const schemaEndpointId = resolveSchemaEndpointId({
    providerId: row.providerId,
    rawId: row.rawId,
    activity: row.activity,
    capabilities: row.capabilities,
    schemaEndpointId: row.schemaEndpointId,
  })
  const schemaPath =
    schemaEndpointId !== null && row.activity !== null
      ? `/v1/schemas/${row.providerId}/${row.activity}/${encodeEndpointId(schemaEndpointId)}`
      : null
  const schemaLink =
    schemaPath === null
      ? undefined
      : halGet(schemaPath, { example: `${schemaPath}?kind=input` })
  const match = linkMatch(row, opts.upstream)
  const aliasOf = opts.aliasOf ?? null
  const go = openCodeGoFacts(row.providerId, row.rawId)
  const sameAs =
    match && opts.upstream
      ? { provider: opts.upstream.provider, rawId: opts.upstream.rawId }
      : null
  const stored = (row.factSources as ModelFactSources | null) ?? null
  const party = opts.makers
    ? firstParty(
        {
          providerId: row.providerId,
          maker: row.maker,
          makerSource: stored?.maker,
          sameAsProvider: sameAs?.provider ?? null,
          linkedFrom: opts.linkedFrom ?? 0,
        },
        opts.makers,
      )
    : { value: null }
  return {
    id: row.id,
    provider: row.providerId,
    rawId: row.rawId,
    sameAs,
    sameAsRoot: sameAs && (opts.root ?? sameAs),
    firstParty: party.value,
    activity: row.activity,
    displayName: row.displayName,
    schemaEndpointId,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    modalities: row.modalities,
    pricing: servePricing(row.pricing, opts.pricing ?? 'compact'),
    pricingRange: row.pricingRange ?? null,
    capabilities: row.capabilities,
    providerMetadata: row.providerMetadata,
    reasoning: row.reasoning,
    serverTools: row.serverTools,
    requestMap: row.requestMap,
    requiredRequestHeaders: go.requiredRequestHeaders,
    trainsOnRequestData:
      row.trainsOnRequestData === true ? true : go.trainsOnRequestData,
    aliases: storedAliases(row.aliases),
    aliasOf,
    releasedAt: row.releasedAt,
    knowledgeCutoff: row.knowledgeCutoff,
    openWeights: row.openWeights,
    weightsUrl: row.weightsUrl,
    maker: row.maker,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    deprecatedAt: row.deprecatedAt,
    deprecation: row.deprecation,
    ...(opts.includeFactSources !== false
      ? {
          factSources: withSourceSilentEvidence(
            row,
            schemaEndpointId,
            modelFactSources(row, match, aliasOf, party.source),
            sourceSilentEvidenceLedger,
          ),
        }
      : {}),
    _links: {
      ...modelLinks(row.providerId),
      ...(schemaLink ? { schema: schemaLink } : {}),
    },
  }
}

export type ApiModel = ReturnType<typeof toApiModel>

function providerLinks(providerId: string) {
  const openapi = openApiLink(providerId)
  return {
    self: halGet(`/v1/providers/${providerId}`),
    models: halGet(`/v1/providers/${providerId}/models`),
    schemas: halGet(`/v1/schemas/${providerId}`),
    ...(openapi ? { openapi } : {}),
  }
}

/** GET /v1/providers — status, counts, spec grain, and links. */
export async function listProvidersCatalog(db: Db) {
  const status = await getServiceStatus(db)
  return {
    providers: status.providers.map((p) => ({
      ...p,
      spec: specDescriptor(p.id, p.counts.endpoints),
      _links: providerLinks(p.id),
    })),
    _links: { self: halGet('/v1/providers'), catalog: halGet('/v1/models') },
  }
}

/**
 * GET /v1/providers/{provider} — one provider's status row plus live model
 * counts per activity: the `?activity=` values `GET /v1/openapi/{provider}`
 * and `GET /v1/models` accept. Null for an unknown provider.
 */
export async function getProviderCatalog(db: Db, providerId: string) {
  const status = await getServiceStatus(db)
  const provider = status.providers.find((p) => p.id === providerId)
  if (!provider) return null
  const rows = await db
    .select({ activity: models.activity, count: sql<number>`count(*)` })
    .from(models)
    .where(and(eq(models.providerId, providerId), isNull(models.deprecatedAt)))
    .groupBy(models.activity)
  const activities: Partial<Record<Activity, number>> = {}
  for (const row of rows) {
    if (row.activity) activities[row.activity] = row.count
  }
  return {
    ...provider,
    spec: specDescriptor(providerId, provider.counts.endpoints),
    activities,
    _links: providerLinks(providerId),
  }
}

/**
 * Catalog rows with their link targets: sameAs and its chain root are
 * primary-key joins; the linked-from count reads the two link indexes.
 */
function catalogRows(db: Db) {
  return db
    .select(catalogSelection)
    .from(models)
    .leftJoin(upstreamModel, eq(models.sameAsModelId, upstreamModel.id))
    .leftJoin(rootModel, eq(models.rootModelId, rootModel.id))
    .leftJoin(aliasTarget, aliasTargetOn(models))
    .$dynamic()
}

/** GET /v1/models — the cross-provider, filterable catalog. */
export async function listModelsCatalog(db: Db, filters: ModelFilters = {}) {
  const conditions: Array<SQL> = []
  if (!filters.includeDeprecated) conditions.push(isNull(models.deprecatedAt))
  if (filters.activity) conditions.push(eq(models.activity, filters.activity))
  if (filters.provider) conditions.push(eq(models.providerId, filters.provider))
  if (filters.capability) {
    // The flag is a bound value, quoted as one JSON path key.
    conditions.push(
      sql`json_extract(${models.capabilities}, ${`$.${JSON.stringify(filters.capability)}`}) = 1`,
    )
  }
  if (filters.q) {
    const needle = `%${filters.q.toLowerCase()}%`
    const textMatch = or(
      like(models.id, needle),
      like(models.rawId, needle),
      like(sql`lower(coalesce(${models.displayName}, ''))`, needle),
    )
    if (textMatch) conditions.push(textMatch)
  }

  const [rows, makers] = await Promise.all([
    catalogRows(db)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(models.id),
    loadMakerContext(db),
  ])
  return {
    count: rows.length,
    models: rows.map(({ row, ...links }) =>
      toApiModel(row, {
        includeFactSources: filters.provenance !== false,
        pricing: filters.pricing === true ? 'full' : 'compact',
        ...links,
        makers,
      }),
    ),
    _links: {
      self: halGet(
        '/v1/models{?activity,provider,capability,q,provenance,pricing}',
        {
          example: '/v1/models?activity=chat&q=claude',
        },
      ),
      providers: halGet('/v1/providers'),
    },
  }
}

/** GET /v1/providers/{provider}/models. Returns null for unknown providers. */
export async function listProviderModels(
  db: Db,
  providerId: string,
  provenance = true,
) {
  const provider = await db.query.providers.findFirst({
    where: eq(providers.id, providerId),
  })
  if (!provider) return null
  const [rows, makers] = await Promise.all([
    catalogRows(db).where(eq(models.providerId, providerId)).orderBy(models.id),
    loadMakerContext(db),
  ])
  return {
    provider: provider.id,
    count: rows.length,
    models: rows.map(({ row, ...links }) =>
      toApiModel(row, {
        pricing: 'compact',
        ...links,
        makers,
        includeFactSources: provenance,
      }),
    ),
    _links: modelLinks(provider.id),
  }
}

/**
 * GET /v1/models/{provider}/{modelId} — accepts the model slug or the raw
 * provider id. Returns null when not found.
 */
export async function getModelDetail(
  db: Db,
  providerId: string,
  modelId: string,
) {
  const direct = await db.query.models.findFirst({
    where: and(
      eq(models.providerId, providerId),
      or(eq(models.id, modelId), eq(models.rawId, modelId)),
    ),
  })
  const aliasHits = direct
    ? []
    : await db
        .select()
        .from(models)
        .where(
          and(
            eq(models.providerId, providerId),
            sql`exists (select 1 from json_each(${models.aliases}) where json_each.value = ${modelId})`,
          ),
        )
  const resolved = direct ?? resolveAlias(modelId, aliasHits)
  if (!resolved) return null
  const [[selected], makers] = await Promise.all([
    catalogRows(db).where(eq(models.id, resolved.id)),
    loadMakerContext(db),
  ])
  if (!selected) return null
  const { row, ...links } = selected
  const body = toApiModel(row, {
    includeFactSources: true,
    pricing: 'full',
    ...links,
    makers,
  })
  const joinIds = openRouterJoinIds(providerId, row.rawId)
  if (joinIds.length === 0) return { ...body, discrepancies: [] }
  const matches = await db
    .select()
    .from(models)
    .where(
      and(eq(models.providerId, 'openrouter'), inArray(models.rawId, joinIds)),
    )
  const byRaw = new Map(matches.map((match) => [match.rawId, match]))
  const openrouter = joinIds
    .map((id) => byRaw.get(id))
    .find((match) => match !== undefined)
  const discrepancies = openrouter
    ? factDiscrepancies(
        {
          contextWindow: row.contextWindow,
          maxOutput: row.maxOutput,
          modalities: row.modalities,
          capabilities: row.capabilities,
          factSources: (row.factSources as ModelFactSources | null) ?? null,
        },
        {
          rawId: openrouter.rawId,
          contextWindow: openrouter.contextWindow,
          maxOutput: openrouter.maxOutput,
          modalities: openrouter.modalities,
          capabilities: openrouter.capabilities,
        },
      )
    : []
  return { ...body, discrepancies }
}

/** Valid provider ids, for 404 remediation messages. */
export async function knownProviderIds(db: Db): Promise<Array<string>> {
  const rows = await db.select({ id: providers.id }).from(providers)
  return rows.map((r) => r.id).sort()
}
