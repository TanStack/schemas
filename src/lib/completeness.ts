/**
 * Completeness: the share of the facts `@tanstack/ai-models` needs that a
 * provider's rows carry. The one definition behind `pnpm run gap:report`
 * (`scripts/gap-report.ts`) and `completeness` on `GET /v1/status`, so the
 * CLI and the site cannot disagree. No Node or Workers dependencies.
 *
 * Each activity has its own fact set (`ACTIVITY_FACTS`). A row whose
 * activity is null is a gap (`unclassified`); a row whose activity has no
 * fact set is listed with `facts: null` and never scored. `originLinks`
 * counts the rows with `sameAs` served; it is information, not a fact.
 *
 * `docs/source-silent/<provider>.md` lists facts a provider does not publish;
 * those are left out of that provider's score and listed under `silent`.
 */
import { isCapabilityMap, supportedFlags } from './capabilities.ts'
import { modelLedgerScope, parseLedgerEntry } from './source-silence-ledger.ts'

export const FACT_KEYS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'priced',
  'cacheRead',
  'capabilities',
  'reasoning',
  'efforts',
  'requestMap',
  'endpoint',
  'replayReasoningContent',
  'outputModalities',
  'activity',
] as const

export type FactKey = (typeof FACT_KEYS)[number]

const MEDIA_FACTS = [
  'priced',
  'endpoint',
  'modalities',
  'outputModalities',
] as const satisfies ReadonlyArray<FactKey>

/** The bucket a row with a null activity is counted in. */
export const UNCLASSIFIED = 'unclassified'

/**
 * The facts scored per activity. An activity not listed here has no fact
 * set: its rows show as `facts: null` and do not change the score. A row
 * with no activity is in `unclassified`, whose one fact it always lacks.
 */
export const ACTIVITY_FACTS = {
  chat: [
    'contextWindow',
    'maxOutput',
    'modalities',
    'priced',
    'cacheRead',
    'capabilities',
    'reasoning',
    'efforts',
    'requestMap',
    'endpoint',
    'replayReasoningContent',
  ],
  image: MEDIA_FACTS,
  video: MEDIA_FACTS,
  audio: MEDIA_FACTS,
  [UNCLASSIFIED]: ['activity'],
} as const satisfies Record<string, ReadonlyArray<FactKey>>

export type ScoredActivity = keyof typeof ACTIVITY_FACTS

/** The chat facts, in table order. */
export const CHAT_FACT_KEYS: ReadonlyArray<FactKey> = ACTIVITY_FACTS.chat

/**
 * Row shapes `@tanstack/ai-models` cannot read correctly, counted apart from
 * the score (issue #323). The score counts a fact as filled; a flag says the
 * stored value still leaves the catalog to guess.
 */
export const FLAG_KEYS = [
  'mandatoryUnknown',
  'reasoningUnknown',
  'outputModalitiesEmpty',
  'mandatoryWithNone',
] as const

export type FlagKey = (typeof FLAG_KEYS)[number]

/** The fields of a `/v1/models` row the report reads. */
export type ModelRow = {
  provider: string
  /** Exact native model id, never the slugged catalog id. */
  rawId?: string
  /** The upstream row this one is linked to, as `/v1/models` serves it. */
  sameAs?: { provider: string; rawId: string } | null
  activity?: string | null
  contextWindow?: number | null
  maxOutput?: number | null
  modalities?: { input?: unknown; output?: unknown } | null
  pricing?: {
    tables?: { rate?: Record<string, unknown> }
    source?: { url?: string }
  } | null
  capabilities?: unknown
  reasoning?: {
    mode?: string
    mandatory?: boolean | null
    efforts?: Array<string>
  } | null
  requestMap?: unknown
  schemaEndpointId?: string | null
  /**
   * `cacheRead.path === 'not-offered'` is a stated absence: the provider's
   * pricing table shows a cached-input cell that is "-" or blank. That
   * fills the fact. It is not a price.
   */
  factSources?: {
    cacheRead?: { path?: string } | null
  } | null
}

export type FactTally = { have: number; need: number }

export type ActivityReport = {
  rows: number
  /** Null when the activity has no fact set: its rows are not scored. */
  facts: Partial<Record<FactKey, FactTally>> | null
  /** Applicable missing rows excluded by exact model-scoped evidence. */
  modelSilent: Partial<Record<FactKey, number>>
  /** Facts filled and needed, ledgered ones left out. */
  filled: number
  needed: number
  /** 0 to 1; null when `facts` is null. 1 when every needed fact is ledgered. */
  score: number | null
}

export type ProviderReport = {
  provider: string
  rows: number
  /** Rows with a null activity, counted in `activities.unclassified`. */
  noActivity: number
  fromModelsDev: number
  /** By activity, plus `unclassified` for rows with none. */
  activities: Partial<Record<string, ActivityReport>>
  /**
   * Rows with `sameAs` served: the links `reconcileSameAs`
   * (`src/server/ingest/model-identity.ts`) wrote. A count, not a fact: the
   * rules read what a served row does not carry (stated evidence that
   * resolves to nothing, the namespace table, the maker declaration), so
   * the scorer cannot tell which unlinked rows could be linked, and a
   * "needs a link" read from `sameAs` would always equal this count.
   */
  originLinks: number
  silent: Array<FactKey>
  /**
   * 0 to 1 over every scored activity. Null when nothing is scored: every
   * row's activity has no fact set.
   */
  score: number | null
  /** Raw ids of the chat rows each flag matches. */
  flags: Record<FlagKey, Array<string>>
}

export type GapReport = {
  generatedAt: string
  providers: Array<ProviderReport>
}

/**
 * Ledger facts served as `factSources` evidence and never scored: the gap
 * report does not count them, so an entry changes no score.
 */
export const EVIDENCE_KEYS = ['serverTools'] as const

export type LedgerKey = FactKey | (typeof EVIDENCE_KEYS)[number]

/** Provider id or provider/exact-raw-id → facts its sources do not publish. */
export type Ledger = Map<string, Set<LedgerKey>>

function isLedgerKey(value: string): value is LedgerKey {
  return ([...FACT_KEYS, ...EVIDENCE_KEYS] as ReadonlyArray<string>).includes(
    value,
  )
}

function isScoredActivity(value: string): value is ScoredActivity {
  return Object.hasOwn(ACTIVITY_FACTS, value)
}

/** Ledger entries are list lines: `- <provider>: <fact> — <why>`. */
export function parseLedger(markdown: string): Ledger {
  const ledger: Ledger = new Map()
  for (const line of markdown.split('\n')) {
    const entry = parseLedgerEntry(line)
    if (!entry) continue
    const { scope, fact } = entry
    // Origin links are a count, not a scored fact: nothing to ledger.
    if (fact === 'originLink' || fact === 'originLinks') {
      throw new Error(
        `source-silent ledger: origin links are not scored, do not ledger them: ${line}`,
      )
    }
    if (!isLedgerKey(fact)) {
      throw new Error(
        `source-silent ledger: unknown fact "${fact}" in: ${line}`,
      )
    }
    // Activity is our classification, not something a provider publishes.
    if (fact === 'activity') {
      throw new Error(
        `source-silent ledger: classify the row, do not ledger it: ${line}`,
      )
    }
    const facts = ledger.get(scope) ?? new Set<LedgerKey>()
    facts.add(fact)
    ledger.set(scope, facts)
  }
  return ledger
}

/**
 * Public endpoint id, query and leading slash stripped. The route's wire
 * is this path. There is no provider list.
 */
function endpointPath(endpointId: string | null | undefined): string {
  if (!endpointId) return ''
  return endpointId.split('?')[0]?.replace(/^\/+/, '') ?? ''
}

/**
 * OpenAI-compatible chat wire: `chat/completions`, `completions`, or
 * `responses`. `ChatRequestMap` describes that wire.
 */
function openAiCompatRoute(row: ModelRow): boolean {
  return /(?:^|\/)(?:chat\/completions|responses|completions)$/.test(
    endpointPath(row.schemaEndpointId),
  )
}

/**
 * `reasoning_content` is the chat-completions field. Anthropic thinking
 * blocks, Gemini thought signatures, Responses reasoning items, and
 * Converse replay on other paths, so those routes are not scored.
 */
function reasoningContentRoute(row: ModelRow): boolean {
  return /(?:^|\/)chat\/completions$/.test(endpointPath(row.schemaEndpointId))
}

function reasons(row: ModelRow): boolean {
  return (
    row.reasoning != null ||
    supportedFlags(row.capabilities).includes('reasoning')
  )
}

function isModelsDev(row: ModelRow): boolean {
  const url = row.pricing?.source?.url
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return hostname === 'models.dev' || hostname.endsWith('.models.dev')
  } catch {
    return false
  }
}

/**
 * The rate rows a lever must appear in: the base row, or, for a card with
 * no base (BytePlus off-peak/peak, picked by a required lever), every row.
 * Empty when absent or a models.dev price.
 */
function rateRows(row: ModelRow): Array<Record<string, unknown>> {
  if (isModelsDev(row)) return []
  const rate = row.pricing?.tables?.rate
  if (!rate) return []
  const rows = 'base' in rate ? [rate.base] : Object.values(rate)
  return rows.every((r) => typeof r === 'object' && r !== null)
    ? (rows as Array<Record<string, unknown>>)
    : []
}

// Listing-compiled cards use OpenRouter's key names, parsed cards ours.
function hasRate(row: ModelRow, ...keys: Array<string>): boolean {
  const rows = rateRows(row)
  return (
    rows.length > 0 &&
    rows.every((r) => keys.some((key) => typeof r[key] === 'number'))
  )
}

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0

/**
 * `need`: the fact applies to this row. `have`: the row carries it. Only
 * the facts of the row's activity are asked (`ACTIVITY_FACTS`).
 */
const FACTS: Record<
  FactKey,
  {
    need?: (row: ModelRow) => boolean
    have: (row: ModelRow) => boolean
  }
> = {
  contextWindow: { have: (row) => row.contextWindow != null },
  maxOutput: { have: (row) => row.maxOutput != null },
  modalities: { have: (row) => nonEmpty(row.modalities?.input) },
  outputModalities: { have: (row) => nonEmpty(row.modalities?.output) },
  // Chat needs token rates; an image, video or audio card bills other
  // units, so any stored card that is not a models.dev price fills it.
  priced: {
    have: (row) =>
      row.activity === 'chat'
        ? hasRate(row, 'input_tokens', 'prompt') &&
          hasRate(row, 'output_tokens', 'completion')
        : row.pricing != null && !isModelsDev(row),
  },
  cacheRead: {
    have: (row) =>
      hasRate(row, 'cache_read_tokens', 'input_cache_read') ||
      row.factSources?.cacheRead?.path === 'not-offered',
  },
  capabilities: { have: (row) => isCapabilityMap(row.capabilities) },
  // Filled by any stored object, whatever its `mandatory`: null there means
  // the source is silent on turning thinking off, which is a stored fact.
  reasoning: {
    need: (row) =>
      row.reasoning != null ||
      supportedFlags(row.capabilities).includes('reasoning'),
    have: (row) => row.reasoning != null,
  },
  // Only `effort` and `adaptive` rows need effort names; a `toggle` or
  // `budget` row needs none. `mandatory` plays no part: efforts with
  // `mandatory: null` is filled, and the `mandatoryUnknown` flag counts it.
  efforts: {
    need: (row) =>
      row.reasoning?.mode === 'effort' || row.reasoning?.mode === 'adaptive',
    have: (row) => (row.reasoning?.efforts?.length ?? 0) > 0,
  },
  requestMap: {
    need: openAiCompatRoute,
    have: (row) => row.requestMap != null,
  },
  endpoint: { have: (row) => row.schemaEndpointId != null },
  replayReasoningContent: {
    need: (row) => reasoningContentRoute(row) && reasons(row),
    have: (row) =>
      typeof row.requestMap === 'object' &&
      row.requestMap !== null &&
      !Array.isArray(row.requestMap) &&
      typeof (row.requestMap as Record<string, unknown>)
        .replayReasoningContent === 'boolean',
  },
  activity: { have: (row) => row.activity != null },
}

/**
 * `reasoningUnknown` is the `reasoning` gap, so a `reasoning` ledger entry
 * for the provider or the exact model clears it. No ledger entry clears
 * the other flags: each is a stored value in the wrong shape.
 */
const FLAGS: Record<
  FlagKey,
  { silencedBy?: FactKey; match: (row: ModelRow) => boolean }
> = {
  // The catalog cannot tell if it can offer an off level.
  mandatoryUnknown: {
    match: (row) =>
      row.reasoning?.mode === 'effort' && row.reasoning.mandatory === null,
  },
  // The catalog has to guess the mode and the levels.
  reasoningUnknown: {
    silencedBy: 'reasoning',
    match: (row) =>
      FACTS.reasoning.need?.(row) === true && !FACTS.reasoning.have(row),
  },
  // The catalog reads `[]` as unknown; an unknown list is stored as null.
  outputModalitiesEmpty: {
    match: (row) => {
      const output = row.modalities?.output
      return Array.isArray(output) && output.length === 0
    },
  },
  // Thinking cannot be turned off, yet `none` turns it off.
  mandatoryWithNone: {
    match: (row) =>
      row.reasoning?.mandatory === true &&
      (row.reasoning.efforts?.includes('none') ?? false),
  },
}

/** One applicable fact of one row. */
export type RowFact = {
  fact: FactKey
  have: boolean
  /** Provider-wide ledgered, or missing and ledgered for this exact model. */
  silent: boolean
}

/** The row's bucket in `ProviderReport.activities`. */
export function activityBucket(row: Pick<ModelRow, 'activity'>): string {
  return row.activity ?? UNCLASSIFIED
}

/**
 * The facts that apply to one row and whether it carries each: its
 * activity's set. Empty for an activity with no fact set.
 */
export function scoreRow(
  row: ModelRow,
  ledger: Ledger = new Map(),
): Array<RowFact> {
  const bucket = activityBucket(row)
  const keys: ReadonlyArray<FactKey> = isScoredActivity(bucket)
    ? ACTIVITY_FACTS[bucket]
    : []
  const providerSilent = ledger.get(row.provider)
  const modelSilent =
    row.rawId === undefined
      ? undefined
      : ledger.get(modelLedgerScope(row.provider, row.rawId))
  return keys.flatMap((fact): Array<RowFact> => {
    const { need, have } = FACTS[fact]
    if (need && !need(row)) return []
    const has = have(row)
    const silent =
      providerSilent?.has(fact) === true ||
      (!has && modelSilent?.has(fact) === true)
    return [{ fact, have: has, silent }]
  })
}

/** Filled of needed for one row, and the names of the facts it lacks. */
export function rowCompleteness(facts: Array<RowFact>): {
  filled: number
  needed: number
  missing: Array<FactKey>
} {
  const counted = facts.filter((f) => !f.silent)
  return {
    filled: counted.filter((f) => f.have).length,
    needed: counted.length,
    missing: counted.filter((f) => !f.have).map((f) => f.fact),
  }
}

/** Facts filled and needed across a provider, ledgered ones left out. */
export function scoredFacts(
  report: Pick<ProviderReport, 'activities'>,
): FactTally {
  let have = 0
  let need = 0
  for (const activity of Object.values(report.activities)) {
    have += activity?.filled ?? 0
    need += activity?.needed ?? 0
  }
  return { have, need }
}

const ratio = ({ have, need }: FactTally, rows: number): number | null =>
  need > 0 ? have / need : rows > 0 ? 1 : null

export function buildReport(
  rows: Array<ModelRow>,
  ledger: Ledger = new Map(),
  now: Date = new Date(),
): GapReport {
  const byProvider = new Map<string, Array<ModelRow>>()
  for (const row of rows) {
    const group = byProvider.get(row.provider)
    if (group) group.push(row)
    else byProvider.set(row.provider, [row])
  }

  const providers = [...byProvider].map(([provider, group]): ProviderReport => {
    const silent = FACT_KEYS.filter((key) => ledger.get(provider)?.has(key))
    const activities: Record<string, ActivityReport> = {}
    for (const row of group) {
      const bucket = activityBucket(row)
      const report = (activities[bucket] ??= {
        rows: 0,
        facts: isScoredActivity(bucket)
          ? Object.fromEntries(
              ACTIVITY_FACTS[bucket].map((key) => [key, { have: 0, need: 0 }]),
            )
          : null,
        modelSilent: {},
        filled: 0,
        needed: 0,
        score: null,
      })
      report.rows += 1
      for (const { fact, have, silent: rowSilent } of scoreRow(row, ledger)) {
        const providerSilent = silent.includes(fact)
        const modelSilent = rowSilent && !providerSilent
        const tally = report.facts?.[fact]
        if (!tally) continue
        tally.need += 1
        if (have) tally.have += 1
        if (modelSilent) {
          report.modelSilent[fact] = (report.modelSilent[fact] ?? 0) + 1
        }
        if (providerSilent || modelSilent) continue
        report.needed += 1
        if (have) report.filled += 1
      }
    }
    for (const report of Object.values(activities)) {
      report.score = report.facts
        ? ratio({ have: report.filled, need: report.needed }, report.rows)
        : null
    }
    const chat = group.filter((row) => row.activity === 'chat')
    const modelLedgered = (row: ModelRow, key: FactKey) =>
      row.rawId !== undefined &&
      ledger.get(modelLedgerScope(provider, row.rawId))?.has(key)
    const flags = Object.fromEntries(
      FLAG_KEYS.map((key) => {
        const { silencedBy, match } = FLAGS[key]
        const isSilent = (row: ModelRow) =>
          silencedBy !== undefined &&
          (silent.includes(silencedBy) || modelLedgered(row, silencedBy))
        return [
          key,
          chat
            .filter((row) => match(row) && !isSilent(row))
            .map((row) => row.rawId ?? ''),
        ]
      }),
    ) as ProviderReport['flags']

    const total = scoredFacts({ activities })
    const scoredRows = Object.values(activities)
      .filter((a) => a.facts !== null)
      .reduce((sum, a) => sum + a.rows, 0)
    return {
      provider,
      rows: group.length,
      noActivity: activities[UNCLASSIFIED]?.rows ?? 0,
      fromModelsDev: group.filter(isModelsDev).length,
      activities,
      originLinks: group.filter((row) => row.sameAs != null).length,
      silent,
      score: ratio(total, scoredRows),
      flags,
    }
  })

  const rank = (score: number | null) => score ?? Number.POSITIVE_INFINITY
  providers.sort(
    (a, b) =>
      rank(a.score) - rank(b.score) || a.provider.localeCompare(b.provider),
  )
  return { generatedAt: now.toISOString(), providers }
}
