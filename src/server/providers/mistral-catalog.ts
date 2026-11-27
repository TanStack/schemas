/**
 * The models overview and each model page embed the same catalog record
 * (issue #771). `docs.mistral.ai/models.md` now redirects to a section
 * index with no table, and the HTML page no longer renders the old
 * Model | API name markdown. Records are read from the RSC payload.
 * A record that is present but unreadable throws. A page with no catalog
 * record is an empty list, so the older tooltip and markdown parsers
 * still run on fixtures.
 */
const MODEL_ID = /^[a-z0-9][a-z0-9._/-]*$/
const SLUG = /^[a-z0-9-]+$/
const STATUSES = new Set(['ga', 'publicPreview', 'deprecated', 'retired'])

export interface MistralCatalogPrice {
  direction: 'input' | 'output'
  label: string
  /** Null when the unit is written inside the label, `Input (/M tokens)`. */
  unit: string | null
  priceUsd: number
}

export interface MistralCatalogModel {
  slug: string
  status: 'ga' | 'publicPreview' | 'deprecated' | 'retired'
  /** Callable API ids. Empty when the row is a family page, not a model. */
  modelIds: Array<string>
  shortDescription: string
  deprecatedAt: string | null
  retiredAt: string | null
  /** API ids of the replacement, primary first. Null when the page names none. */
  replacementIds: Array<string> | null
  inputs: Array<string>
  outputs: Array<string>
  features: Array<string>
  maxOutputTokens: number | null
  releasedAt: string | null
  pricing: Array<MistralCatalogPrice>
  isFree: boolean
}

const REQUIRED = [
  'slug',
  'status',
  'modelIds',
  'shortDescription',
  'deprecatedAt',
  'retiredAt',
  'replacedBy',
  'inputs',
  'outputs',
  'features',
  'maxOutputTokens',
  'releasedAt',
  'pricing',
  'isFree',
] as const

type Json =
  | null
  | string
  | number
  | boolean
  | Array<Json>
  | { [key: string]: Json }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rscValues(html: string): Array<unknown> {
  const stream = [
    ...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g),
  ]
    .map((match) => JSON.parse(match[1] ?? '""') as string)
    .join('')
  const values: Array<unknown> = []
  for (const line of stream.split('\n')) {
    const row = /^[0-9a-f]+:(.*)$/.exec(line)
    if (!row?.[1]) continue
    try {
      values.push(JSON.parse(row[1]) as Json)
    } catch {
      // A text or import row, not a catalog record.
    }
  }
  return values
}

function ids(value: unknown, slug: string, what: string): Array<string> {
  if (!Array.isArray(value)) {
    throw new Error(`mistral catalog ${slug}: ${what} ${JSON.stringify(value)}`)
  }
  const parsed: Array<string> = []
  for (const id of value) {
    if (typeof id !== 'string' || !MODEL_ID.test(id)) {
      throw new Error(
        `mistral catalog ${slug}: ${what} ${JSON.stringify(value)}`,
      )
    }
    if (!parsed.includes(id)) parsed.push(id)
  }
  return parsed
}

function strings(value: unknown, slug: string, what: string): Array<string> {
  if (!Array.isArray(value)) {
    throw new Error(`mistral catalog ${slug}: ${what} ${JSON.stringify(value)}`)
  }
  const parsed: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(
        `mistral catalog ${slug}: ${what} ${JSON.stringify(value)}`,
      )
    }
    parsed.push(item)
  }
  return parsed
}

function instant(value: unknown, slug: string, what: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`mistral catalog ${slug}: ${what} ${JSON.stringify(value)}`)
  }
  return value
}

function prices(value: unknown, slug: string): Array<MistralCatalogPrice> {
  if (!Array.isArray(value)) {
    throw new Error(`mistral catalog ${slug}: pricing ${JSON.stringify(value)}`)
  }
  return value.map((row) => {
    if (
      !isRecord(row) ||
      (row.direction !== 'input' && row.direction !== 'output') ||
      typeof row.label !== 'string' ||
      row.label.length === 0 ||
      (row.unit !== null && typeof row.unit !== 'string') ||
      typeof row.priceUsd !== 'number' ||
      !Number.isFinite(row.priceUsd)
    ) {
      throw new Error(
        `mistral catalog ${slug}: pricing row ${JSON.stringify(row)}`,
      )
    }
    return {
      direction: row.direction,
      label: row.label,
      unit: row.unit,
      priceUsd: row.priceUsd,
    }
  })
}

/**
 * `null` is no successor. A record's `modelIds` are the successor's API
 * ids. A number is Payload's unpopulated relation id. The page resolves
 * it later, from the catalog record with that `id`.
 */
function replacementIds(
  value: unknown,
  slug: string,
): { ids: Array<string> | null; unread: boolean; relationId: number | null } {
  if (value === null) return { ids: null, unread: false, relationId: null }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { ids: null, unread: true, relationId: value }
  }
  if (!isRecord(value)) {
    throw new Error(`mistral catalog ${slug}: replacement has no API name`)
  }
  const parsed = ids(value.modelIds, slug, 'replacement')
  if (parsed.length === 0) {
    throw new Error(`mistral catalog ${slug}: replacement has no API name`)
  }
  return { ids: parsed, unread: false, relationId: null }
}

/** Payload's numeric id, when the record carries one. */
function recordId(node: Record<string, unknown>, slug: string): number | null {
  if (!('id' in node)) return null
  if (typeof node.id === 'number' && Number.isInteger(node.id)) return node.id
  throw new Error(`mistral catalog ${slug}: id ${JSON.stringify(node.id)}`)
}

/** One catalog record, or null when `node` is some other RSC value. */
function readModel(node: Record<string, unknown>): CatalogDraft | null {
  if (!REQUIRED.every((key) => key in node)) return null
  const slug = node.slug
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error(`mistral catalog: slug ${JSON.stringify(slug)}`)
  }
  const status = node.status
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    throw new Error(`mistral catalog ${slug}: status ${JSON.stringify(status)}`)
  }
  // Family pages state no summary. Any other shape is unreadable.
  if (
    node.shortDescription !== null &&
    typeof node.shortDescription !== 'string'
  ) {
    throw new Error(`mistral catalog ${slug}: shortDescription is not text`)
  }
  if (typeof node.isFree !== 'boolean') {
    throw new Error(`mistral catalog ${slug}: isFree is not a boolean`)
  }
  const maxOutputTokens = node.maxOutputTokens
  if (
    maxOutputTokens !== null &&
    (typeof maxOutputTokens !== 'number' ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 0)
  ) {
    throw new Error(
      `mistral catalog ${slug}: maxOutputTokens ${JSON.stringify(maxOutputTokens)}`,
    )
  }
  const replacement = replacementIds(node.replacedBy, slug)
  return {
    slug,
    recordId: recordId(node, slug),
    status: status as MistralCatalogModel['status'],
    modelIds: ids(node.modelIds, slug, 'modelIds'),
    shortDescription: node.shortDescription ?? '',
    deprecatedAt: instant(node.deprecatedAt, slug, 'deprecatedAt'),
    retiredAt: instant(node.retiredAt, slug, 'retiredAt'),
    replacementIds: replacement.ids,
    replacementUnread: replacement.unread,
    replacementRelationId: replacement.relationId,
    inputs: strings(node.inputs, slug, 'inputs'),
    outputs: strings(node.outputs, slug, 'outputs'),
    features: strings(node.features, slug, 'features'),
    maxOutputTokens,
    releasedAt: instant(node.releasedAt, slug, 'releasedAt'),
    pricing: prices(node.pricing, slug),
    isFree: node.isFree,
  }
}

interface CatalogDraft extends MistralCatalogModel {
  /** Payload id. Null when this copy of the record does not carry one. */
  recordId: number | null
  /** True when this copy's `replacedBy` is an unpopulated relation id. */
  replacementUnread: boolean
  /** The relation id, when `replacementUnread` is true. */
  replacementRelationId: number | null
}

function sameReplacement(prior: CatalogDraft, model: CatalogDraft): boolean {
  if (prior.replacementUnread && model.replacementUnread) {
    return prior.replacementRelationId === model.replacementRelationId
  }
  // An unpopulated relation id agrees with the populated record, not with
  // a copy that says there is no successor.
  if (prior.replacementUnread) return model.replacementIds !== null
  if (model.replacementUnread) return prior.replacementIds !== null
  return (
    JSON.stringify(prior.replacementIds) ===
    JSON.stringify(model.replacementIds)
  )
}

function withoutReplacement(model: CatalogDraft): string {
  const {
    replacementIds: _ids,
    replacementUnread: _unread,
    replacementRelationId: _relation,
    ...rest
  } = model
  return JSON.stringify(rest)
}

/**
 * API ids of the catalog record whose Payload `id` is `relationId`.
 * Undefined when this page embeds no such record. Two records with that
 * id and different `modelIds` throw. An empty list is a successor the
 * page names with no API id.
 */
function relationModelIds(
  models: Array<CatalogDraft>,
  relationId: number,
): Array<string> | undefined {
  let found: Array<string> | undefined
  for (const model of models) {
    if (model.recordId !== relationId) continue
    if (found === undefined) {
      found = model.modelIds
      continue
    }
    if (JSON.stringify(found) !== JSON.stringify(model.modelIds)) {
      throw new Error(
        `mistral catalog: replacement ${String(relationId)} names two API lists`,
      )
    }
  }
  return found
}

function walk(node: unknown, out: Array<CatalogDraft>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return
  }
  if (!isRecord(node)) return
  const model = readModel(node)
  if (model) out.push(model)
  for (const value of Object.values(node)) walk(value, out)
}

export interface ParseMistralCatalogOptions {
  /**
   * A model page does not have to embed the successor. Deprecations are
   * read from the overview, which stays fail-closed (this flag off).
   * An unresolved relation id becomes `replacementIds: null`.
   */
  allowUnreadReplacement?: boolean
}

/**
 * Catalog records in a docs HTML page, one per slug. An HTML page with
 * no catalog record returns an empty list. Two records for one slug that
 * disagree throw. A `replacedBy` number is the successor's Payload id:
 * the record with that id on the same page supplies the API ids. The
 * overview throws when that record is absent. A model page does not.
 */
export function parseMistralCatalog(
  html: string,
  options?: ParseMistralCatalogOptions,
): Array<MistralCatalogModel> {
  if (!html.includes('__next_f')) return []
  const found: Array<CatalogDraft> = []
  for (const value of rscValues(html)) walk(value, found)
  const bySlug = new Map<string, CatalogDraft>()
  for (const model of found) {
    const prior = bySlug.get(model.slug)
    if (!prior) {
      bySlug.set(model.slug, model)
      continue
    }
    if (
      withoutReplacement(prior) !== withoutReplacement(model) ||
      !sameReplacement(prior, model)
    ) {
      throw new Error(`mistral catalog ${model.slug}: models disagree`)
    }
    if (prior.replacementUnread && !model.replacementUnread) {
      bySlug.set(model.slug, model)
    }
  }
  const drafts = [...bySlug.values()]
  return drafts.map((model) => {
    if (model.replacementUnread) {
      const resolved =
        model.replacementRelationId === null
          ? undefined
          : relationModelIds(drafts, model.replacementRelationId)
      if (resolved === undefined) {
        if (!options?.allowUnreadReplacement) {
          throw new Error(
            `mistral catalog ${model.slug}: replacement has no API name`,
          )
        }
        model.replacementIds = null
      } else if (resolved.length === 0) {
        throw new Error(
          `mistral catalog ${model.slug}: replacement has no API name`,
        )
      } else {
        model.replacementIds = resolved
      }
    }
    const {
      recordId: _recordId,
      replacementUnread: _unread,
      replacementRelationId: _relation,
      ...rest
    } = model
    return rest
  })
}

/** The record for this page's slug, or null when the page has no catalog. */
export function mistralPageCatalog(
  html: string,
  slug: string,
): MistralCatalogModel | null {
  const models = parseMistralCatalog(html, { allowUnreadReplacement: true })
  if (models.length === 0) return null
  const own = models.filter((model) => model.slug === slug)
  if (own.length !== 1) {
    throw new Error(
      `mistral model page ${slug}: catalog names ${String(own.length)} matching models`,
    )
  }
  return own[0] ?? null
}

/** Epoch seconds for a catalog timestamp. Null stays null. */
export function mistralCatalogInstant(
  value: string | null,
  what: string,
): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new Error(`${what}: ${JSON.stringify(value)}`)
  }
  return ms / 1000
}
