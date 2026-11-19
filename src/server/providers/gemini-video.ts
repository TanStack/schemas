/**
 * Gemini video request schemas, one per model (issue #658).
 *
 * Video runs on the Interactions API (`POST /v1beta/interactions`), which
 * the Discovery document does not have. Google publishes it as OpenAPI.
 * That document's `VideoResponseFormat.duration` is an unbounded string;
 * the range is on each model's docs page (`Output video 3s-15s`). Each
 * clip model's schema is Google's create request with `model` pinned and
 * `duration` narrowed to that range.
 *
 * A page that states a resolution, fps and token rate (#697) is a
 * real-time stream. The Interactions document publishes no `world_setup`
 * or connect operation for it, so it gets no fixed-duration schema and a
 * named warning. A page that fails to fetch, or a limit shape the parser
 * does not know, rejects this whole fetch. A partial run would mark every
 * missing video endpoint removed (`sync.ts`).
 *
 * Which pages: the models-index pages for the ids Google's video guide
 * names. Nothing here falls back: a document that lost the shape, or a
 * guide that leads to no output-video limit, throws with its URL, and the
 * sync keeps the stored schemas.
 */
import { extractEndpointSchemas } from '../ingest/bundle.ts'
import {
  GEMINI_MODELS_INDEX_URL,
  parseModelIndexDocs,
  parsePageSections,
} from './gemini-features.ts'
import type { GeminiOutputVideo } from './gemini-features.ts'
import { mapConcurrent } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { BundledEndpoint, OpenApiDocument } from './types.ts'

export const GEMINI_INTERACTIONS_SPEC_URL =
  'https://ai.google.dev/static/api/interactions.openapi.json'
export const GEMINI_VIDEO_GUIDE_URL =
  'https://aistudio.google.com/docs/video.md'

const CREATE_PATH = '/{api_version}/interactions'
const REQUEST = 'CreateModelInteractionParams'
const VIDEO_FORMAT = 'VideoResponseFormat'

export type GeminiVideoModel = {
  rawId: string
  /** The model page that states the limit. */
  pageUrl: string
} & GeminiOutputVideo

/** The clip half of {@link GeminiVideoModel}: a page that stated `Ns-Ms`. */
interface GeminiClipModel {
  rawId: string
  pageUrl: string
  minSeconds: number
  maxSeconds: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each model code on a model page whose section states an output video limit. */
export function parseVideoModels(
  page: string,
  pageUrl: string,
): Array<GeminiVideoModel> {
  return parsePageSections(page).flatMap(({ codes, outputVideo }) =>
    outputVideo
      ? codes.map((rawId) => ({ rawId, pageUrl, ...outputVideo }))
      : [],
  )
}

function isClipModel(model: GeminiVideoModel): model is GeminiClipModel {
  return 'minSeconds' in model && 'maxSeconds' in model
}

/** Issue #697: the Interactions spec has no stream create body to narrow. */
export function streamVideoWarning(rawId: string): string {
  return `${rawId}: real-time stream, no fixed-duration create schema`
}

/**
 * One model's video route: Google's create-interaction request with `model`
 * pinned and `response_format.duration` an enum of whole seconds. The stored
 * path is the real one (`/v1beta/interactions`); the model id is the
 * endpoint id.
 */
export function geminiVideoEndpoint(
  spec: OpenApiDocument,
  model: GeminiClipModel,
  specHash: string,
): { endpoint: BundledEndpoint; warnings: Array<string> } {
  const lost = (what: string) =>
    new Error(
      `gemini video: ${GEMINI_INTERACTIONS_SPEC_URL} has no ${what}; ${model.rawId} gets no schema`,
    )
  const operation = spec.paths?.[CREATE_PATH]?.post
  if (!operation) throw lost(`POST ${CREATE_PATH}`)
  const version = spec.info?.version
  if (typeof version !== 'string' || !/^v\d/.test(version)) {
    throw lost('info.version to fill {api_version}')
  }
  const schemas = spec.components?.schemas ?? {}
  const request = schemas[REQUEST]
  if (
    !isRecord(request) ||
    !isRecord(request.properties) ||
    !('model' in request.properties) ||
    !('response_format' in request.properties)
  ) {
    throw lost(`${REQUEST} with model and response_format`)
  }
  const format = schemas[VIDEO_FORMAT]
  const duration =
    isRecord(format) && isRecord(format.properties)
      ? format.properties.duration
      : undefined
  if (
    !isRecord(format) ||
    !isRecord(format.properties) ||
    !isRecord(duration) ||
    duration.type !== 'string'
  ) {
    throw lost(`${VIDEO_FORMAT}.duration string`)
  }
  const seconds = Array.from(
    { length: model.maxSeconds - model.minSeconds + 1 },
    (_, i) => `${String(model.minSeconds + i)}s`,
  )
  const range = `${String(model.minSeconds)}s to ${String(model.maxSeconds)}s`
  const narrowed: OpenApiDocument = {
    ...spec,
    paths: {
      [CREATE_PATH]: {
        post: {
          ...operation,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${REQUEST}` },
              },
            },
          },
        },
      },
    },
    components: {
      ...spec.components,
      schemas: {
        ...schemas,
        [REQUEST]: {
          ...request,
          properties: {
            ...request.properties,
            model: {
              type: 'string',
              enum: [model.rawId],
              description: 'The model that generates the video.',
            },
          },
        },
        [VIDEO_FORMAT]: {
          ...format,
          properties: {
            ...format.properties,
            duration: {
              type: 'string',
              enum: seconds,
              description: `The duration for the video output, in whole seconds. ${model.rawId} generates ${range} (${model.pageUrl}, Output video).`,
            },
          },
        },
      },
    },
  }
  const extracted = extractEndpointSchemas(narrowed, CREATE_PATH, 'post-200')
  if (!extracted.input) throw lost('bundled request schema')
  return {
    endpoint: {
      publicId: model.rawId,
      path: CREATE_PATH.replace('{api_version}', version),
      activity: 'video',
      description: `Generate a video with ${model.rawId} (Interactions API). response_format.duration is ${range}.`,
      source: { url: GEMINI_INTERACTIONS_SPEC_URL, hash: specHash },
      // Google's document, plus one limit read from the model's docs page.
      derivation: 'generated',
      input: extracted.input,
      ...(extracted.output ? { output: extracted.output } : {}),
    },
    warnings: extracted.warnings,
  }
}

/** The models-index pages for the ids the video guide names. */
export function videoModelPages(guide: string, index: string): Array<string> {
  const named = new Set(
    [...guide.matchAll(/`([a-z0-9][a-z0-9.-]*)`/g)].map((match) => match[1]),
  )
  return parseModelIndexDocs(index)
    .filter((doc) => doc.ids.some((id) => named.has(id)))
    .map((doc) => `${doc.url}.md`)
}

/** Every Gemini video model's endpoint, from the live documents. */
export async function geminiVideoEndpoints(): Promise<{
  endpoints: Array<BundledEndpoint>
  warnings: Array<string>
}> {
  const [specText, guide, index] = await Promise.all([
    fetchText(GEMINI_INTERACTIONS_SPEC_URL),
    fetchText(GEMINI_VIDEO_GUIDE_URL),
    fetchText(GEMINI_MODELS_INDEX_URL),
  ])
  const pages = videoModelPages(guide, index)
  const models = (
    await mapConcurrent(pages, 4, async (url) =>
      parseVideoModels(await fetchText(url), url),
    )
  ).flat()
  if (models.length === 0) {
    throw new Error(
      `gemini video: ${GEMINI_VIDEO_GUIDE_URL} leads to no model with an Output video limit (${String(pages.length)} model pages read: ${pages.join(', ') || 'none'})`,
    )
  }
  const warnings: Array<string> = []
  const clips = models.filter(isClipModel)
  for (const model of models) {
    if (isClipModel(model)) continue
    const warning = streamVideoWarning(model.rawId)
    warnings.push(warning)
    console.error(`gemini video: ${warning}`)
  }
  const spec = JSON.parse(specText) as OpenApiDocument
  const specHash = await sha256Text(specText)
  const built = clips.map((model) => geminiVideoEndpoint(spec, model, specHash))
  return {
    endpoints: built.map((item) => item.endpoint),
    warnings: [...warnings, ...built.flatMap((item) => item.warnings)],
  }
}
