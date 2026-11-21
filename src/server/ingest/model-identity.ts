import { eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import { originNameKey } from '#/lib/origin-key.ts'
import { stableStringify } from '#/server/kv.ts'
import { changedFactPaths, modelUpdatedPayload } from './change-facts.ts'
import type {
  SameAsInference,
  UpstreamModelIdentity,
} from '#/server/providers/types.ts'

export interface UpstreamIdentityWrite {
  id: string
  identity: UpstreamModelIdentity | null
}

/** Whether a row's stored evidence already says what the provider states. */
export function sameEvidence(
  row: typeof models.$inferSelect | undefined,
  identity: UpstreamModelIdentity | null,
): boolean {
  return (
    (row?.upstreamProvider ?? null) === (identity?.providerNamespace ?? null) &&
    (row?.upstreamRawId ?? null) === (identity?.rawId ?? null) &&
    stableStringify(row?.upstreamSource ?? null) ===
      stableStringify(identity?.source ?? null)
  )
}

/** Write identity evidence in batches; reconcileSameAs owns the link. */
export async function persistUpstreamIdentities(
  db: Db,
  identities: readonly UpstreamIdentityWrite[],
): Promise<void> {
  for (let i = 0; i < identities.length; i += 30) {
    const statements = identities.slice(i, i + 30).map(({ id, identity }) =>
      db
        .update(models)
        .set({
          upstreamProvider: identity?.providerNamespace ?? null,
          upstreamRawId: identity?.rawId ?? null,
          upstreamSource: identity?.source ?? null,
        })
        .where(eq(models.id, id)),
    )
    const [first, ...rest] = statements
    if (first) await db.batch([first, ...rest])
  }
}

/** One row as the reconcile step reads it. */
export interface LinkRow {
  id: string
  provider_id: string
  raw_id: string
  aliases: string | null
  maker: string | null
  /** 1 when the row's provider states an upstream for it. */
  stated: number
  /** The stated tiers' answer; null when they resolve to no single row. */
  stated_target: string | null
  same_as_model_id: string | null
  root_model_id: string | null
  same_as_inference: string | null
  /** 1 when the row's provider is declared a maker. */
  declared: number | null
}

/** Hops followed before a chain is called a loop. */
const MAX_HOPS = 8

/**
 * The row a chain of links ends at: `id` itself when it has no link. Null
 * when the chain loops or runs past MAX_HOPS: such a chain has no root.
 */
function chainEnd(
  id: string,
  next: (id: string) => string | null,
): string | null {
  const seen = new Set([id])
  let at = id
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const to = next(at)
    if (to === null) return at
    if (seen.has(to)) return null
    seen.add(to)
    at = to
  }
  return null
}

function parseAliases(value: string | null): Array<string> {
  if (value === null) return []
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed)
    ? parsed.filter((alias): alias is string => typeof alias === 'string')
    : []
}

/**
 * The name tier (issue #719), for rows whose provider states no upstream
 * and is not declared a maker. Candidates are the rows that can stand for
 * an origin: a row whose stated link resolves (it stands for its chain's
 * end), and a declared maker's row with no stated upstream and no `maker`
 * (it stands for itself). A row links to the one root every candidate at
 * another provider leads to. Candidates that lead to two roots (regional
 * twins), to a looping chain, or back to the row itself give no link.
 * Name-inferred links are never candidates, so one inference never feeds
 * another.
 */
export function inferLinks(
  rows: ReadonlyArray<LinkRow>,
  prefixes: ReadonlySet<string>,
): Map<string, { target: string; inference: SameAsInference }> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const statedNext = (id: string) => {
    const row = byId.get(id)
    return row?.stated ? row.stated_target : null
  }
  const candidates = new Map<string, Array<LinkRow>>()
  for (const row of rows) {
    const origin = row.stated
      ? row.stated_target !== null
      : row.declared === 1 && row.maker === null
    if (!origin) continue
    const keys = new Set(
      [row.raw_id, ...parseAliases(row.aliases)].map((id) =>
        originNameKey(id, prefixes),
      ),
    )
    for (const key of keys) {
      const list = candidates.get(key) ?? []
      list.push(row)
      candidates.set(key, list)
    }
  }
  const inferred = new Map<
    string,
    { target: string; inference: SameAsInference }
  >()
  for (const row of rows) {
    if (row.stated || row.declared === 1) continue
    const key = originNameKey(row.raw_id, prefixes)
    const matched = (candidates.get(key) ?? []).filter(
      (candidate) => candidate.provider_id !== row.provider_id,
    )
    if (matched.length === 0) continue
    const roots = new Set(
      matched.map((candidate) => chainEnd(candidate.id, statedNext)),
    )
    const [root, ...others] = roots
    if (others.length > 0 || !root || root === row.id) continue
    if (byId.get(root)?.provider_id === row.provider_id) continue
    inferred.set(row.id, {
      target: root,
      inference: {
        key,
        candidates: matched
          .map((candidate) => ({
            provider: candidate.provider_id,
            rawId: candidate.raw_id,
          }))
          .sort((a, b) =>
            `${a.provider}/${a.rawId}`.localeCompare(
              `${b.provider}/${b.rawId}`,
            ),
          ),
      },
    })
  }
  return inferred
}

type LinkState = { sameAsModelId: string | null; rootModelId: string | null }

/**
 * Resolve stored evidence into links, catalog-wide. The stated namespace is
 * a provider id, or a name exactly one provider claims in
 * `provider_model_namespaces`. Within that provider an exact id wins, then a
 * documented alias, then the same two with dots read as hyphens (gateways
 * write `claude-opus-4.5` for Anthropic's `claude-opus-4-5`). More than one
 * match at the winning tier is ambiguous: no link. A row with stated
 * evidence is never linked by name, even when that evidence resolves to
 * nothing; a row with none goes to the name tier (`inferLinks`). A link's
 * chain end is stored as `root_model_id` when it is more than one hop away,
 * and a link whose chain loops is dropped. Evidence is never touched here,
 * so a target that arrives later links without re-polling the reseller.
 */
export async function reconcileSameAs(db: Db, now: number): Promise<void> {
  const rows = await db.all<LinkRow>(sql`
    WITH sources AS (
      SELECT id, upstream_raw_id AS raw_id,
        coalesce(
          (SELECT id FROM providers WHERE id = models.upstream_provider),
          (SELECT CASE WHEN count(*) = 1 THEN max(provider_id) END
            FROM provider_model_namespaces
            WHERE namespace = models.upstream_provider)
        ) AS provider_id
      FROM models WHERE upstream_provider IS NOT NULL
    ), candidates AS (
      SELECT source.id AS source_id, target.id AS target_id,
        CASE
          WHEN target.raw_id = source.raw_id THEN 0
          WHEN EXISTS (
            SELECT 1 FROM json_each(target.aliases)
            WHERE value = source.raw_id
          ) THEN 1
          ELSE 2
        END AS tier
      FROM sources source
      JOIN models target ON target.provider_id = source.provider_id
        AND target.id != source.id
      WHERE target.raw_id IN (
          source.raw_id, replace(source.raw_id, '.', '-')
        ) OR EXISTS (
          SELECT 1 FROM json_each(target.aliases) WHERE value IN (
            source.raw_id, replace(source.raw_id, '.', '-')
          )
        )
    ), resolved AS (
      SELECT source_id,
        CASE WHEN count(*) = 1 THEN max(target_id) END AS target_id
      FROM (
        SELECT *, min(tier) OVER (PARTITION BY source_id) AS best
        FROM candidates
      )
      WHERE tier = best
      GROUP BY source_id
    )
    SELECT m.id, m.provider_id, m.raw_id, m.aliases, m.maker,
      m.upstream_provider IS NOT NULL AS stated,
      resolved.target_id AS stated_target,
      m.same_as_model_id, m.root_model_id, m.same_as_inference,
      p.makes_own_models AS declared
    FROM models m
    LEFT JOIN resolved ON resolved.source_id = m.id
    LEFT JOIN providers p ON p.id = m.provider_id
  `)
  const prefixes = new Set(
    (
      await db.all<{ name: string }>(sql`
        SELECT id AS name FROM providers
        UNION SELECT namespace FROM provider_model_namespaces
      `)
    ).map(({ name }) => name.toLowerCase()),
  )

  const inferred = inferLinks(rows, prefixes)
  const linkOf = new Map<string, string>()
  for (const row of rows) {
    const target = row.stated
      ? row.stated_target
      : (inferred.get(row.id)?.target ?? null)
    if (target !== null) linkOf.set(row.id, target)
  }
  const next = (id: string) => linkOf.get(id) ?? null

  const diffs: Array<{
    id: string
    providerId: string
    before: LinkState
    after: LinkState
    inference: SameAsInference | null
  }> = []
  for (const row of rows) {
    const direct = linkOf.get(row.id) ?? null
    const end = direct === null ? null : chainEnd(row.id, next)
    // A loop has no root: refuse the link rather than serve a wrong one.
    const target = end === null ? null : direct
    const after: LinkState = {
      sameAsModelId: target,
      rootModelId: target !== null && end !== target ? end : null,
    }
    const inference =
      target !== null && !row.stated
        ? (inferred.get(row.id)?.inference ?? null)
        : null
    const before: LinkState = {
      sameAsModelId: row.same_as_model_id,
      rootModelId: row.root_model_id,
    }
    const storedInference: unknown =
      row.same_as_inference === null ? null : JSON.parse(row.same_as_inference)
    if (
      before.sameAsModelId === after.sameAsModelId &&
      before.rootModelId === after.rootModelId &&
      stableStringify(storedInference) === stableStringify(inference)
    ) {
      continue
    }
    diffs.push({
      id: row.id,
      providerId: row.provider_id,
      before,
      after,
      inference,
    })
  }

  // A link and its change row commit together: a failed chunk leaves its
  // rows still differing, so the next run emits them. Ten rows keep the
  // insert under D1's 100-bound-parameter limit. New evidence for an
  // unchanged link is written with no event.
  for (let i = 0; i < diffs.length; i += 10) {
    const chunk = diffs.slice(i, i + 10)
    const events = chunk.flatMap((row) => {
      const changed = changedFactPaths(row.before, row.after)
      return changed.length === 0
        ? []
        : [
            {
              id: crypto.randomUUID(),
              type: 'model.updated' as const,
              providerId: row.providerId,
              subjectId: row.id,
              summary: 'Upstream model link updated',
              payload: modelUpdatedPayload(row.before, row.after, changed),
              createdAt: now,
            },
          ]
    })
    const [first, ...rest] = chunk.map((row) =>
      db
        .update(models)
        .set({
          sameAsModelId: row.after.sameAsModelId,
          rootModelId: row.after.rootModelId,
          sameAsInference: row.inference,
        })
        .where(eq(models.id, row.id)),
    )
    if (!first) continue
    await (events.length > 0
      ? db.batch([db.insert(changes).values(events), first, ...rest])
      : db.batch([first, ...rest]))
  }
}
