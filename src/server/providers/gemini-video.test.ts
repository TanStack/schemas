import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parsePageOutputVideo } from './gemini-features.ts'
import {
  GEMINI_INTERACTIONS_SPEC_URL,
  geminiVideoEndpoint,
  parseVideoModels,
  videoModelPages,
} from './gemini-video.ts'
import type { OpenApiDocument } from './types.ts'

/** https://aistudio.google.com/docs/models/gemini-omni-flash.md, 2026-11-16. */
const OMNI_PAGE = readFileSync(
  new URL('./fixtures/gemini-omni-flash.md.txt', import.meta.url),
  'utf8',
)
const PAGE_URL = 'https://aistudio.google.com/docs/models/gemini-omni-flash.md'

const INDEX = `
{% table variant="model" %}
  * Model
  * Endpoint

  ---

  * [Gemini 3.5 Transcribe](/docs/models/gemini-3.5-transcribe)
  * \`gemini-3.5-transcribe\`

  ---

  * [Gemini Omni Flash](/docs/models/gemini-omni-flash)
  * \`gemini-omni-1.2-flash\`   
    \`gemini-omni-1.1-flash\`
{% /table %}
`

/** The parts of Google's Interactions document the builder reads. */
function spec(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Gemini API', version: 'v1beta' },
    paths: {
      '/{api_version}/interactions': {
        post: {
          operationId: 'CreateInteraction',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      $ref: '#/components/schemas/CreateAgentInteractionParams',
                    },
                    {
                      $ref: '#/components/schemas/CreateModelInteractionParams',
                    },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Interaction' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateAgentInteractionParams: { type: 'object' },
        CreateModelInteractionParams: {
          type: 'object',
          required: ['input', 'model'],
          properties: {
            model: { $ref: '#/components/schemas/ModelOption' },
            input: { type: 'string' },
            response_format: { $ref: '#/components/schemas/ResponseFormat' },
          },
        },
        ModelOption: { type: 'string', enum: ['gemini-omni-1.1-flash'] },
        ResponseFormat: {
          oneOf: [{ $ref: '#/components/schemas/VideoResponseFormat' }],
        },
        VideoResponseFormat: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { const: 'video' },
            aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
            duration: { type: 'string', format: 'google-duration' },
            resolution: { type: 'string', enum: ['360p', '720p'] },
          },
        },
        Interaction: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  }
}

describe('parsePageOutputVideo', () => {
  it('reads the whole-second range', () => {
    expect(
      parsePageOutputVideo(
        '| Limits | **Output video** 3s-15s (360p, 24 FPS) |',
      ),
    ).toEqual({ minSeconds: 3, maxSeconds: 15 })
  })

  it('is null on a page with no output video limit', () => {
    expect(
      parsePageOutputVideo('| Limits | **Output token limit** 8,192 |'),
    ).toBe(null)
  })

  it('throws on a limit it cannot read, so no unbounded schema is published', () => {
    expect(() =>
      parsePageOutputVideo('| Limits | **Output video** up to 15 seconds |'),
    ).toThrow('unreadable Output video limit "up to 15 seconds"')
  })
})

describe('parseVideoModels', () => {
  it("binds each section's range to its own model code", () => {
    expect(parseVideoModels(OMNI_PAGE, PAGE_URL)).toEqual([
      {
        rawId: 'gemini-omni-1.2-flash',
        pageUrl: PAGE_URL,
        minSeconds: 3,
        maxSeconds: 15,
      },
      {
        rawId: 'gemini-omni-1.1-flash',
        pageUrl: PAGE_URL,
        minSeconds: 3,
        maxSeconds: 10,
      },
    ])
  })
})

describe('videoModelPages', () => {
  it('follows the ids the video guide names to their index pages', () => {
    const guide =
      'Use [Gemini Omni Flash](/docs/omni) (`gemini-omni-1.2-flash`). `veo-3.1-generate-preview` was shut down.'
    expect(videoModelPages(guide, INDEX)).toEqual([PAGE_URL])
  })

  it('is empty when the guide names no indexed model', () => {
    expect(videoModelPages('Video understanding only.', INDEX)).toEqual([])
  })
})

describe('geminiVideoEndpoint', () => {
  const model = {
    rawId: 'gemini-omni-1.1-flash',
    pageUrl: PAGE_URL,
    minSeconds: 3,
    maxSeconds: 5,
  }

  it('pins the model and narrows duration on the real path', () => {
    const { endpoint } = geminiVideoEndpoint(spec(), model, 'h'.repeat(64))
    expect(endpoint).toMatchObject({
      publicId: 'gemini-omni-1.1-flash',
      path: '/v1beta/interactions',
      activity: 'video',
      derivation: 'generated',
      source: { url: GEMINI_INTERACTIONS_SPEC_URL, hash: 'h'.repeat(64) },
    })
    const input = endpoint.input as {
      properties: Record<string, unknown>
      $defs: Record<string, { properties: Record<string, { enum?: unknown }> }>
    }
    // The model request only: the agent variant is another route's body.
    expect(input.properties.model).toMatchObject({
      type: 'string',
      enum: ['gemini-omni-1.1-flash'],
    })
    const format = input.$defs.VideoResponseFormat?.properties
    expect(format?.duration?.enum).toEqual(['3s', '4s', '5s'])
    expect(format?.aspect_ratio?.enum).toEqual(['16:9', '9:16'])
    expect(format?.resolution?.enum).toEqual(['360p', '720p'])
    expect(endpoint.output).toMatchObject({ type: 'object' })
  })

  it('throws when the document no longer has a duration string', () => {
    const changed = spec()
    const schemas = changed.components?.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >
    delete schemas.VideoResponseFormat?.properties?.duration
    expect(() => geminiVideoEndpoint(changed, model, 'h')).toThrow(
      `${GEMINI_INTERACTIONS_SPEC_URL} has no VideoResponseFormat.duration string; gemini-omni-1.1-flash gets no schema`,
    )
  })

  it('throws when the create operation is gone', () => {
    expect(() =>
      geminiVideoEndpoint({ ...spec(), paths: {} }, model, 'h'),
    ).toThrow('has no POST /{api_version}/interactions')
  })
})
