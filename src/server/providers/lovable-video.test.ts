import { Validator } from '@cfworker/json-schema'
import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { provider } from './adapters/lovable.ts'
import { applyLovableVideoSchema } from './lovable-video.ts'
import type { OpenApiDocument } from './types.ts'

const LISTED = [
  'google/veo-3.1',
  'google/veo-3.1-fast',
  'google/veo-3.1-lite',
  'google/gemini-omni-1.1-flash',
]

function soraSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    paths: {
      '/videos': {
        post: {
          summary: 'Create a video',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  $ref: '#/components/schemas/CreateVideoMultipartBody',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/VideoResource' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        VideoModel: {
          anyOf: [
            { type: 'string' },
            { type: 'string', enum: ['sora-2', 'sora-2-pro'] },
          ],
        },
        VideoSeconds: { type: 'string', enum: ['4', '8', '12'] },
        VideoSize: {
          type: 'string',
          enum: ['720x1280', '1280x720', '1024x1792', '1792x1024'],
        },
        CreateVideoMultipartBody: {
          type: 'object',
          description: 'Create a Sora video.',
          properties: {
            model: {
              $ref: '#/components/schemas/VideoModel',
              description:
                'The video generation model to use (allowed values: sora-2, sora-2-pro). Defaults to `sora-2`.',
            },
            prompt: {
              type: 'string',
              description: 'Text prompt that describes the video to generate.',
            },
            input_reference: {
              type: 'string',
              format: 'binary',
              description: 'Optional reference asset.',
            },
            seconds: {
              $ref: '#/components/schemas/VideoSeconds',
              description:
                'Clip duration in seconds (allowed values: 4, 8, 12). Defaults to 4 seconds.',
            },
            size: {
              $ref: '#/components/schemas/VideoSize',
              description:
                'Output resolution formatted as width x height (allowed values: 720x1280, 1280x720, 1024x1792, 1792x1024). Defaults to 720x1280.',
            },
          },
          required: ['prompt'],
        },
        CreateVideoJsonBody: {
          type: 'object',
          properties: {
            model: {
              description: 'allowed values: sora-2, sora-2-pro',
            },
            prompt: { type: 'string' },
            seconds: {
              description: 'allowed values: 4, 8, 12',
            },
          },
          required: ['prompt'],
        },
        VideoResource: {
          type: 'object',
          properties: {
            model: { $ref: '#/components/schemas/VideoModel' },
            seconds: { $ref: '#/components/schemas/VideoSeconds' },
            size: { $ref: '#/components/schemas/VideoSize' },
          },
        },
      },
    },
  }
}

function bundledInput(ids: ReadonlyArray<string> = LISTED) {
  const spec = soraSpec()
  applyLovableVideoSchema(spec, ids)
  const { endpoints } = classifyAndBundle(provider, {
    specs: [spec],
    sources: [{ url: 'https://example.test/openapi.yml', hash: 'fixture' }],
    outputStrategy: 'post-200',
  })
  const video = endpoints.find((endpoint) => endpoint.path === '/videos')
  if (!video?.input) throw new Error('missing bundled video input')
  return { spec, video, input: video.input }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function branch(
  input: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const defs = input.$defs
  if (!isRecord(defs)) throw new Error('no $defs')
  const found = Object.values(defs).find((schema) => {
    if (!isRecord(schema) || !isRecord(schema.properties)) return false
    const modelField = schema.properties.model
    if (!isRecord(modelField)) return false
    return JSON.stringify(modelField.enum) === JSON.stringify([model])
  })
  if (!isRecord(found)) throw new Error(`no branch for ${model}`)
  return found
}

function accepts(schema: Record<string, unknown>, payload: unknown): boolean {
  return new Validator(schema, '2020-12', false).validate(payload).valid
}

describe('lovable video schema', () => {
  it('allows 6 seconds on Veo and rejects 12 and Sora sizes', () => {
    const { video, input } = bundledInput()
    expect(video.derivation).toBe('docs-derived')
    expect(video.verifiedAt).toBe('2026-11-16')
    expect(JSON.stringify(input)).not.toMatch(/sora/i)
    expect(JSON.stringify(video.output)).not.toMatch(/sora/i)

    const veo = branch(input, 'google/veo-3.1')
    const lite = branch(input, 'google/veo-3.1-lite')
    const omni = branch(input, 'google/gemini-omni-1.1-flash')

    expect(
      accepts(veo, { model: 'google/veo-3.1', prompt: 'a cat', seconds: '6' }),
    ).toBe(true)
    expect(
      accepts(veo, { model: 'google/veo-3.1', prompt: 'a cat', seconds: '12' }),
    ).toBe(false)
    expect(
      accepts(veo, {
        model: 'google/veo-3.1',
        prompt: 'a cat',
        seconds: '8',
        size: '3840x2160',
      }),
    ).toBe(true)
    expect(
      accepts(veo, {
        model: 'google/veo-3.1',
        prompt: 'a cat',
        seconds: '4',
        size: '1920x1080',
      }),
    ).toBe(false)
    expect(
      accepts(lite, {
        model: 'google/veo-3.1-lite',
        prompt: 'a cat',
        seconds: '6',
        size: '3840x2160',
      }),
    ).toBe(false)
    expect(
      accepts(lite, {
        model: 'google/veo-3.1-lite',
        prompt: 'a cat',
        seconds: '6',
        size: '1280x720',
      }),
    ).toBe(true)
    expect(
      accepts(omni, {
        model: 'google/gemini-omni-1.1-flash',
        prompt: 'a cat',
        seconds: '3',
        size: '640x360',
      }),
    ).toBe(true)
    expect(
      accepts(omni, {
        model: 'google/gemini-omni-1.1-flash',
        prompt: 'a cat',
        seconds: '10',
      }),
    ).toBe(true)
    expect(
      accepts(omni, {
        model: 'google/gemini-omni-1.1-flash',
        prompt: 'a cat',
        seconds: '12',
      }),
    ).toBe(false)
    expect(
      accepts(omni, {
        model: 'google/gemini-omni-1.1-flash',
        prompt: 'a cat',
        size: '1024x1792',
      }),
    ).toBe(false)
  })

  it('rejects the whole request when the model and the branch disagree', () => {
    const { input } = bundledInput()
    expect(
      accepts(input, {
        model: 'google/veo-3.1-lite',
        prompt: 'a cat',
        seconds: '6',
        size: '3840x2160',
      }),
    ).toBe(false)
    expect(
      accepts(input, {
        model: 'google/veo-3.1',
        prompt: 'a cat',
        seconds: '6',
        size: '1280x720',
      }),
    ).toBe(true)
  })

  it('throws when a listed video model has no limits', () => {
    expect(() => applyLovableVideoSchema(soraSpec(), ['google/veo-4'])).toThrow(
      /no video limits for google\/veo-4/,
    )
    expect(() => applyLovableVideoSchema(soraSpec(), [])).toThrow(
      /listed no video ids/,
    )
  })
})
