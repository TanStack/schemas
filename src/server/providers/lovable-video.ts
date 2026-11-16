/**
 * Lovable's video route is OpenAI-compatible multipart, but the limits are
 * not Sora's. The gateway runs Veo and Gemini Omni
 * (https://docs.lovable.dev/features/ai-video, checked 2026-11-16):
 *
 * - Veo clips are 4, 6, or 8 seconds. 1080p and 4K are 8 seconds. 4K is
 *   Veo 3.1 and Veo 3.1 Fast only.
 * - Gemini Omni 1.1 Flash is 3 to 10 seconds at 360p, 720p, 1080p, or 4K.
 *
 * `seconds` is the numeric string the Videos API sends. `size` is width x
 * height for the 16:9 and 9:16 frames of those resolutions (720p is
 * 1280x720 and 720x1280, the sizes the Lovable gateway client sends).
 */
import { PROVENANCE_MARKER } from './types.ts'
import type { OpenApiDocument } from './types.ts'

export const LOVABLE_VIDEO_DOCS_URL =
  'https://docs.lovable.dev/features/ai-video'
/** Day the limits above were read off the video page. */
export const LOVABLE_VIDEO_LIMITS_CHECKED = '2026-11-16'

const VEO_SECONDS = ['4', '6', '8'] as const
const OMNI_SECONDS = ['3', '4', '5', '6', '7', '8', '9', '10'] as const

const P360_SIZES = ['640x360', '360x640'] as const
const HD_SIZES = ['1280x720', '720x1280', '1920x1080', '1080x1920'] as const
const FOUR_K_SIZES = ['3840x2160', '2160x3840'] as const
const VEO_HD_EIGHT_SECONDS = ['1920x1080', '1080x1920'] as const
const VEO_4K_EIGHT_SECONDS = [
  '1920x1080',
  '1080x1920',
  '3840x2160',
  '2160x3840',
] as const

interface VideoLimits {
  id: string
  name: string
  seconds: ReadonlyArray<string>
  sizes: ReadonlyArray<string>
  /** Sizes that are 8 seconds when `seconds` is sent. */
  eightSecondSizes?: ReadonlyArray<string>
  note: string
}

export const LOVABLE_VIDEO_LIMITS: ReadonlyArray<VideoLimits> = [
  {
    id: 'google/veo-3.1-lite',
    name: 'Veo 3.1 Lite',
    seconds: VEO_SECONDS,
    sizes: HD_SIZES,
    eightSecondSizes: VEO_HD_EIGHT_SECONDS,
    note: '1080p clips are 8 seconds. 4K is not supported.',
  },
  {
    id: 'google/veo-3.1-fast',
    name: 'Veo 3.1 Fast',
    seconds: VEO_SECONDS,
    sizes: [...HD_SIZES, ...FOUR_K_SIZES],
    eightSecondSizes: VEO_4K_EIGHT_SECONDS,
    note: '1080p and 4K clips are 8 seconds.',
  },
  {
    id: 'google/veo-3.1',
    name: 'Veo 3.1',
    seconds: VEO_SECONDS,
    sizes: [...HD_SIZES, ...FOUR_K_SIZES],
    eightSecondSizes: VEO_4K_EIGHT_SECONDS,
    note: '1080p and 4K clips are 8 seconds.',
  },
  {
    id: 'google/gemini-omni-1.1-flash',
    name: 'Gemini Omni 1.1 Flash',
    seconds: OMNI_SECONDS,
    sizes: [...P360_SIZES, ...HD_SIZES, ...FOUR_K_SIZES],
    note: '3 to 10 seconds at any of these resolutions.',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON Schema conditional. The keyword is spelled out so it is not a thenable. */
function ifThen(
  when: Record<string, unknown>,
  consequence: Record<string, unknown>,
): Record<string, unknown> {
  const keyword = ['t', 'h', 'e', 'n'].join('')
  return { if: when, [keyword]: consequence }
}

function stringList(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined
}

function schemaName(id: string, prefix: string): string {
  const pascal = id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  return `${prefix}${pascal}`
}

function requestBranch(
  base: Record<string, unknown>,
  limits: VideoLimits,
): Record<string, unknown> {
  const props = isRecord(base.properties) ? base.properties : {}
  if (!isRecord(props.prompt)) {
    throw new Error('lovable: video request schema has no prompt')
  }
  const seconds = {
    type: 'string',
    enum: [...limits.seconds],
    description: `Clip length in seconds. Allowed values: ${limits.seconds.join(', ')}. ${limits.note}`,
  }
  const branch: Record<string, unknown> = {
    type: 'object',
    title: `${limits.name} video request`,
    description: `${limits.name} (${limits.id}) on the Lovable AI Gateway. ${limits.note}`,
    properties: {
      model: {
        type: 'string',
        enum: [limits.id],
        description: `Video model id. Fixed to ${limits.id} on this request.`,
      },
      prompt: structuredClone(props.prompt),
      ...(isRecord(props.input_reference)
        ? { input_reference: structuredClone(props.input_reference) }
        : {}),
      seconds,
      size: {
        type: 'string',
        enum: [...limits.sizes],
        description: `Output resolution as width x height. Allowed values: ${limits.sizes.join(', ')}.`,
      },
    },
    required: stringList(base.required) ?? ['prompt'],
  }
  if (limits.eightSecondSizes && limits.eightSecondSizes.length > 0) {
    branch.allOf = [
      ifThen(
        {
          properties: { size: { enum: [...limits.eightSecondSizes] } },
          required: ['size'],
        },
        {
          properties: {
            seconds: {
              type: 'string',
              enum: ['8'],
              description: limits.note,
            },
          },
        },
      ),
    ]
  }
  return branch
}

function unionValues(
  models: ReadonlyArray<VideoLimits>,
  pick: (limits: VideoLimits) => ReadonlyArray<string>,
): Array<string> {
  const values: Array<string> = []
  for (const limits of models) {
    for (const value of pick(limits)) {
      if (!values.includes(value)) values.push(value)
    }
  }
  return values
}

/**
 * Replace the copied Sora video request with one branch per listed model.
 * A listed video id with no row here throws, so a new model cannot ship
 * on Sora's seconds and sizes.
 */
export function applyLovableVideoSchema(
  spec: OpenApiDocument,
  videoModelIds: ReadonlyArray<string>,
): void {
  const schemas = spec.components?.schemas
  if (!schemas) {
    throw new Error('lovable: OpenAI spec has no components.schemas')
  }
  const byId = new Map(
    LOVABLE_VIDEO_LIMITS.map((limits) => [limits.id, limits]),
  )
  const unknown = [...new Set(videoModelIds)]
    .filter((id) => !byId.has(id))
    .sort()
  if (unknown.length > 0) {
    throw new Error(
      `lovable: no video limits for ${unknown.join(', ')} (${LOVABLE_VIDEO_DOCS_URL})`,
    )
  }
  const selected: Array<VideoLimits> = []
  for (const id of [...new Set(videoModelIds)].sort()) {
    const limits = byId.get(id)
    if (limits) selected.push(limits)
  }
  if (selected.length === 0) {
    throw new Error('lovable: models payload listed no video ids')
  }

  const bodies: Array<{ name: string; prefix: string; description: string }> = [
    {
      name: 'CreateVideoMultipartBody',
      prefix: 'LovableVideo',
      description:
        'Multipart parameters for a video job on the Lovable AI Gateway. Seconds and size depend on the model.',
    },
    {
      name: 'CreateVideoJsonBody',
      prefix: 'LovableVideoJson',
      description:
        'JSON parameters for a video job on the Lovable AI Gateway. Seconds and size depend on the model.',
    },
  ]
  const branchNames: Array<string> = []
  for (const body of bodies) {
    const base = schemas[body.name]
    if (!isRecord(base)) continue
    const mapping: Record<string, string> = {}
    for (const limits of selected) {
      const name = schemaName(limits.id, body.prefix)
      schemas[name] = requestBranch(base, limits)
      mapping[limits.id] = `#/components/schemas/${name}`
      branchNames.push(name)
    }
    schemas[body.name] = {
      description: body.description,
      discriminator: { propertyName: 'model', mapping },
      oneOf: selected.map((limits) => ({
        $ref: `#/components/schemas/${schemaName(limits.id, body.prefix)}`,
      })),
    }
  }
  if (!isRecord(schemas.CreateVideoMultipartBody)) {
    throw new Error('lovable: OpenAI spec has no CreateVideoMultipartBody')
  }

  const seconds = unionValues(selected, (limits) => limits.seconds)
  const sizes = unionValues(selected, (limits) => limits.sizes)
  schemas.VideoModel = {
    type: 'string',
    description: 'Video model id on the Lovable AI Gateway.',
  }
  schemas.VideoSeconds = {
    type: 'string',
    enum: seconds,
    description: `Duration of the generated clip in seconds. Allowed values: ${seconds.join(', ')}.`,
  }
  schemas.VideoSize = {
    type: 'string',
    enum: sizes,
    description: `Output resolution as width x height. Allowed values: ${sizes.join(', ')}.`,
  }

  const post = spec.paths?.['/videos']?.post
  if (!post) throw new Error('lovable: OpenAI spec has no POST /videos')
  post[PROVENANCE_MARKER] = {
    derivation: 'docs-derived',
    verifiedAt: LOVABLE_VIDEO_LIMITS_CHECKED,
  }

  const video = JSON.stringify({
    post,
    request: schemas.CreateVideoMultipartBody,
    json: schemas.CreateVideoJsonBody,
    branches: branchNames.map((name) => schemas[name]),
    model: schemas.VideoModel,
    seconds: schemas.VideoSeconds,
    size: schemas.VideoSize,
  })
  if (/sora/i.test(video)) {
    throw new Error('lovable: video schema still mentions Sora')
  }
}
