import type { ProbeExpect } from './types.ts'

/** Null when the live call still matches the record. */
export function observationMatches(
  expect: ProbeExpect,
  actual: { status: number; payloads: Array<unknown> },
): string | null {
  if (actual.status !== expect.status) {
    return `status ${actual.status}, expected ${expect.status}`
  }
  if (actual.payloads.length === 0) return 'response had no JSON object'
  for (const payload of actual.payloads) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'response JSON was not an object'
    }
    const missing = expect.jsonKeys.filter(
      (key) => !Object.keys(payload).includes(key),
    )
    if (missing.length > 0) return `missing ${missing.join(', ')}`
  }
  return null
}
