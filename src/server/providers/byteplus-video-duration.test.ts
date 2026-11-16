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
