/**
 * Per-model Seedance `duration` bounds.
 *
 * The create schema publishes one integer for every model. The limits live
 * in that field's description ("2-12s on 1.0, 4-12s on 1.5-pro, 4-15s on
 * 2.0, 4-30s on 2.5"). `-1` lets the model choose on 2.5, 2.5 flash, every
 * 2.0 id (base, fast, and mini), and 1.5-pro. The capabilities table on
 * {@link SEEDANCE_DURATION_DOCS} states those rows. 1.0 does not accept
 * `-1`.
 *
 * `?activity=video` copies the shared request once per listed model and
 * writes these bounds onto `duration`, tagged `x-modelschemas-model`. A
 * listed id with no row here keeps the stored `duration` and stays its own
 * branch, so the `anyOf` does not reject it. The poll reports that id.
 */

/** Capabilities overview. Output duration column, read 2026-11-16. */
export const SEEDANCE_DURATION_DOCS =
  'https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-5'

export interface SeedanceDuration {
  min: number
  max: number
  /** The create call accepts -1, and the model chooses the length. */
  auto: boolean
}

export const SEEDANCE_DURATIONS: Record<string, SeedanceDuration> = {
  'dreamina-seedance-2-5-260628': { min: 4, max: 30, auto: true },
  'dreamina-seedance-2-5-flash-261115': { min: 4, max: 30, auto: true },
  'dreamina-seedance-2-0-260128': { min: 4, max: 15, auto: true },
  'dreamina-seedance-2-0-fast-260128': { min: 4, max: 15, auto: true },
  'dreamina-seedance-2-0-mini-260615': { min: 4, max: 15, auto: true },
  'seedance-1-5-pro-251215': { min: 4, max: 12, auto: true },
  'seedance-1-0-pro-250528': { min: 2, max: 12, auto: false },
  'seedance-1-0-pro-fast-251015': { min: 2, max: 12, auto: false },
}

const CREATE_PATH = '/contents/generations/tasks'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy `base`, then `patch`. A string index signature cannot be spread. */
function overlay(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(base), ...Object.entries(patch)])
}

/** `duration` for one model: a bounded integer, plus `-1` where allowed. */
export function seedanceDurationSchema(
  bounds: SeedanceDuration,
): Record<string, unknown> {
  const ranged: Record<string, unknown> = {
    type: 'integer',
    minimum: bounds.min,
    maximum: bounds.max,
    description: `Whole seconds of output, from ${String(bounds.min)} to ${String(bounds.max)}.`,
  }
  if (!bounds.auto) return ranged
  return {
    description: `Whole seconds of output, from ${String(bounds.min)} to ${String(bounds.max)}. -1 lets the model choose the length.`,
    anyOf: [
      ranged,
      {
        type: 'integer',
        const: -1,
        description: 'Let the model choose the length.',
      },
    ],
  }
}

/**
 * Listed video ids with no {@link SEEDANCE_DURATIONS} row, in order, once
 * each. The poll names these; the create document still accepts them.
 */
export function uncoveredSeedanceIds(
  rawIds: ReadonlyArray<string>,
): Array<string> {
  const missing: Array<string> = []
  const seen = new Set<string>()
  for (const rawId of rawIds) {
    if (seen.has(rawId) || Object.hasOwn(SEEDANCE_DURATIONS, rawId)) continue
    seen.add(rawId)
    missing.push(rawId)
  }
  return missing
}

/**
 * One create-request schema per listed model. Ids in
 * {@link SEEDANCE_DURATIONS} get that row's bounds. Any other listed id
 * keeps the stored `duration` and still pins `model`, so a request for it
 * stays valid. Undefined when this operation is not the shared video create
 * call, or when `rawIds` is empty.
 */
export function seedanceActivityRequests(input: {
  path: string
  method: string
  schema: unknown
  rawIds: Array<string>
}): Array<{ rawId: string; schema: unknown }> | undefined {
  if (input.method !== 'POST' || input.path !== CREATE_PATH) return undefined
  const schema = input.schema
  if (!isObject(schema)) return undefined
  const properties = schema.properties
  if (!isObject(properties)) return undefined
  const model = isObject(properties.model)
    ? properties.model
    : { type: 'string' }
  const listed = new Set(input.rawIds)
  const pin = (
    rawId: string,
    duration?: Record<string, unknown>,
  ): Record<string, unknown> =>
    overlay(schema, {
      properties: overlay(properties, {
        model: overlay(model, { enum: [rawId] }),
        ...(duration ? { duration } : {}),
      }),
    })
  const variants: Array<{ rawId: string; schema: unknown }> = []
  for (const rawId of Object.keys(SEEDANCE_DURATIONS)) {
    if (!listed.has(rawId)) continue
    const bounds = SEEDANCE_DURATIONS[rawId]
    if (!bounds) continue
    variants.push({ rawId, schema: pin(rawId, seedanceDurationSchema(bounds)) })
  }
  for (const rawId of uncoveredSeedanceIds(input.rawIds)) {
    variants.push({ rawId, schema: pin(rawId) })
  }
  return variants.length > 0 ? variants : undefined
}
