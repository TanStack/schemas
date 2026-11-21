/**
 * `firstParty` (issue #719): is this provider the maker of this model?
 * Derived at read time from the provider's maker declaration
 * (`providers.makes_own_models`), the row's links, its `maker` and the
 * namespace table. Never stored per row.
 */
import { isNotNull, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models, providerModelNamespaces, providers } from '#/db/schema.ts'
import type { FactSource, FirstPartySource } from '#/server/providers/types.ts'

export interface ProviderMaker {
  declared: boolean
  /** The provider id and its claimed namespaces, lowercased letters and digits. */
  names: Set<string>
  /** Some row here names a maker that is not this provider. */
  hostsOthers: boolean
}

export type MakerContext = Map<string, ProviderMaker>

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Whether a maker name, as a host writes it, names the provider itself:
 * the whole name or its first word is the provider id or a namespace it
 * claims (`Google DeepMind` → `google` → gemini; `ByteDance` → bytedance).
 */
export function makerNamesProvider(
  maker: string,
  names: ReadonlySet<string>,
): boolean {
  const first = maker.trim().split(/[^A-Za-z0-9]+/)[0] ?? ''
  return names.has(squash(maker)) || names.has(squash(first))
}

/** One read per request: the declarations, namespaces and stated makers. */
export async function loadMakerContext(db: Db): Promise<MakerContext> {
  const [declared, namespaces, makers] = await Promise.all([
    db
      .select({ id: providers.id, declared: providers.makesOwnModels })
      .from(providers),
    db.select().from(providerModelNamespaces),
    db
      .selectDistinct({ providerId: models.providerId, maker: models.maker })
      .from(models)
      .where(isNotNull(models.maker)),
  ])
  const context: MakerContext = new Map(
    declared.map((row) => [
      row.id,
      {
        declared: row.declared,
        names: new Set([squash(row.id)]),
        hostsOthers: false,
      },
    ]),
  )
  for (const row of namespaces) {
    context.get(row.providerId)?.names.add(squash(row.namespace))
  }
  for (const row of makers) {
    const provider = context.get(row.providerId)
    if (provider && row.maker && !makerNamesProvider(row.maker, provider.names))
      provider.hostsOthers = true
  }
  return context
}

/** `(rows whose sameAs chain ends at this row)`, for a catalog select. */
export const linkedFromCount = sql<number>`(
  (SELECT count(*) FROM models AS linked WHERE linked.root_model_id = ${models.id})
  + (SELECT count(*) FROM models AS linked
      WHERE linked.same_as_model_id = ${models.id}
        AND linked.root_model_id IS NULL)
)`

export interface FirstPartyInput {
  providerId: string
  maker: string | null
  makerSource: FactSource | undefined
  /** The served sameAs target's provider; null when none is served. */
  sameAsProvider: string | null
  linkedFrom: number
}

/**
 * Whether a row is the declared maker's own model: its provider is
 * declared, its `maker` (if any) names the provider itself, and, on a
 * maker that also hosts other makers' models, its maker source was read
 * for this row. The one predicate for `firstParty` and for the name tier's
 * candidate roots (`inferLinks`).
 */
export function isOwnRow(
  provider: ProviderMaker | undefined,
  maker: string | null,
  makerSource: FactSource | undefined,
): boolean {
  if (!provider?.declared) return false
  if (maker !== null && !makerNamesProvider(maker, provider.names)) return false
  return !provider.hostsOthers || makerSource !== undefined
}

/**
 * Evidence first: a served link to another provider's row, or a `maker`
 * naming someone else, is `false`. Then only the declared maker's own row
 * (`isOwnRow`) can be `true`: from other rows' links ending here, from its
 * maker source on a maker that hosts others, or from the declaration.
 * Otherwise null: a host's row that others link to is not the maker's.
 */
export function firstParty(
  input: FirstPartyInput,
  context: MakerContext,
): { value: boolean | null; source?: FirstPartySource } {
  const provider = context.get(input.providerId)
  if (
    input.sameAsProvider !== null &&
    input.sameAsProvider !== input.providerId
  )
    return { value: false, source: { decidedBy: 'same-as' } }
  if (
    input.maker !== null &&
    provider &&
    input.makerSource &&
    !makerNamesProvider(input.maker, provider.names)
  )
    return {
      value: false,
      source: { decidedBy: 'maker', source: input.makerSource },
    }
  if (!provider || !isOwnRow(provider, input.maker, input.makerSource))
    return { value: null }
  if (input.linkedFrom > 0)
    return {
      value: true,
      source: { decidedBy: 'linked-from', count: input.linkedFrom },
    }
  return provider.hostsOthers && input.makerSource
    ? { value: true, source: { decidedBy: 'maker', source: input.makerSource } }
    : { value: true, source: { decidedBy: 'provider-declared' } }
}
