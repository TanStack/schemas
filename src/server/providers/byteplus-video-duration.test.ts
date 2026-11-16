import { Validator } from '@cfworker/json-schema'
import { describe, expect, it } from 'vitest'

import {
  seedanceActivityRequests,
  uncoveredSeedanceIds,
} from './byteplus-video-duration.ts'

const storedDuration = {
  type: 'integer',
  description: 'Whole seconds. The shared schema states no per-model bounds.',
}

function createSchema(): {
  type: string
  properties: { model: { type: string }; duration: typeof storedDuration }
} {
  return {
    type: 'object',
    properties: {
      model: { type: 'string' },
      duration: storedDuration,
    },
  }
}

function variantsFor(rawIds: Array<string>) {
  return seedanceActivityRequests({
    path: '/contents/generations/tasks',
    method: 'POST',
    schema: createSchema(),
    rawIds,
  })
}

describe('seedanceActivityRequests', () => {
  it('keeps an uncovered listed model on the stored duration', () => {
    const variants = variantsFor([
      'dreamina-seedance-2-5-260628',
      'dreamina-not-in-the-duration-table',
      'dreamina-not-in-the-duration-table',
    ])
    expect(variants?.map((variant) => variant.rawId)).toEqual([
      'dreamina-seedance-2-5-260628',
      'dreamina-not-in-the-duration-table',
    ])
    const extra = variants?.[1]
    expect(extra?.rawId).toBe('dreamina-not-in-the-duration-table')
    if (!extra) return
    const schema = extra.schema as {
      properties: { model: { enum: Array<string> }; duration: unknown }
    }
    expect(schema.properties.model.enum).toEqual([
      'dreamina-not-in-the-duration-table',
    ])
    expect(schema.properties.duration).toEqual(storedDuration)
    expect(schema.properties.duration).not.toHaveProperty('minimum')
  })

  it('states 4–30 seconds and -1 for Seedance 2.5 flash', () => {
    const variant = variantsFor(['dreamina-seedance-2-5-flash-261115'])?.[0]
    expect(variant?.rawId).toBe('dreamina-seedance-2-5-flash-261115')
    if (!variant) return
    const schema = variant.schema as {
      properties: {
        duration: {
          minimum?: number
          anyOf?: Array<{ minimum?: number; maximum?: number; const?: number }>
        }
      }
    }
    const duration = schema.properties.duration
    expect(duration.minimum).toBeUndefined()
    expect(duration.anyOf?.[0]).toMatchObject({ minimum: 4, maximum: 30 })
    expect(duration.anyOf?.[1]).toMatchObject({ const: -1 })
  })

  it('accepts -1 for Seedance 2.0 fast and mini', () => {
    const variants = variantsFor([
      'dreamina-seedance-2-0-fast-260128',
      'dreamina-seedance-2-0-mini-260615',
      'seedance-1-0-pro-fast-251015',
    ])
    const durationOf = (rawId: string) => {
      const variant = variants?.find((item) => item.rawId === rawId)
      expect(variant).toBeDefined()
      if (!variant) return undefined
      const schema = variant.schema as {
        properties: { duration: Record<string, unknown> }
      }
      return schema.properties.duration
    }
    for (const rawId of [
      'dreamina-seedance-2-0-fast-260128',
      'dreamina-seedance-2-0-mini-260615',
    ]) {
      const duration = durationOf(rawId)
      expect(duration).toBeDefined()
      if (!duration) return
      expect(duration.minimum).toBeUndefined()
      const validator = new Validator(duration, '2020-12', false)
      expect(validator.validate(-1).valid).toBe(true)
      expect(validator.validate(4).valid).toBe(true)
      expect(validator.validate(15).valid).toBe(true)
      expect(validator.validate(3).valid).toBe(false)
      expect(validator.validate(16).valid).toBe(false)
    }
    const proFast = durationOf('seedance-1-0-pro-fast-251015')
    expect(proFast).toBeDefined()
    if (!proFast) return
    expect(new Validator(proFast, '2020-12', false).validate(-1).valid).toBe(
      false,
    )
  })

  it('leaves a non-create operation alone', () => {
    expect(
      seedanceActivityRequests({
        path: '/contents/generations/tasks/{id}',
        method: 'GET',
        schema: createSchema(),
        rawIds: ['dreamina-not-in-the-duration-table'],
      }),
    ).toBeUndefined()
    expect(variantsFor([])).toBeUndefined()
  })
})

describe('uncoveredSeedanceIds', () => {
  it('names each missing id once and skips a row that exists', () => {
    expect(
      uncoveredSeedanceIds([
        'dreamina-seedance-2-5-flash-261115',
        'zzz-new',
        'aaa-new',
        'zzz-new',
      ]),
    ).toEqual(['zzz-new', 'aaa-new'])
  })
})
