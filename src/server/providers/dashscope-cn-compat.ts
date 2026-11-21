/**
 * The Beijing OpenAI-compatible chat route and the models it serves, read
 * from the Chinese compat page (issue #716). The page states the full
 * `POST …/compatible-mode/v1/chat/completions` endpoint and a supported
 * models line by family; it publishes no request schema, so the route is
 * stored route-only.
 */
import type { DashscopeCompatScope } from './dashscope-compat.ts'

export const DASHSCOPE_CN_COMPAT =
  'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope.md'

export interface DashscopeCnCompat {
  route: string
  scope: DashscopeCompatScope
}

function fail(message: string): never {
  throw new Error(`dashscope-cn compat: ${message}`)
}

export function parseDashscopeCnCompat(markdown: string): DashscopeCnCompat {
  const routes = new Set(
    [
      ...markdown.matchAll(
        /^北京：POST https:\/\/\{WorkspaceId\}\.cn-beijing\.maas\.aliyuncs\.com\/(\S+\/chat\/completions)$/gm,
      ),
    ].map((match) => match[1] ?? ''),
  )
  const [route] = routes
  if (routes.size !== 1 || !route) fail('no single Beijing chat endpoint')

  const line = /^支持的模型：(.+)$/m.exec(markdown)?.[1]
  if (!line) fail('no 支持的模型 line')
  // Drop the 直供 (supplier) notes, then split the list on 、.
  const items = line
    .replace(/（[^）]*）/g, '')
    .replace(/。\s*$/, '')
    .split('、')
    .map((item) => item.trim())
  if (items.some((item) => !/^[A-Za-z][\w-]*(?: 大语言模型)?$/.test(item)))
    fail(`unreadable supported models line: ${line}`)
  const scope: DashscopeCompatScope = {
    qwenLlm: false,
    qwenKinds: [],
    families: [],
    deny: [],
  }
  for (const item of items) {
    if (item === 'Qwen 大语言模型') {
      scope.qwenLlm = true
      continue
    }
    const [family = '', kind] = item.toLowerCase().split('-')
    if (family === 'qwen' && kind) scope.qwenKinds.push(kind)
    else scope.families.push(family)
  }
  if (/Qwen-Audio不支持OpenAI兼容协议/.test(markdown)) scope.deny.push('audio')
  return { route, scope }
}

/**
 * Pages that name a Qwen family the compat line would otherwise cover and
 * state it is served on another protocol. Neither page lists model ids
 * (realtime.md sends readers to the console for names), so the family
 * name in the page title is the match, with the same token rule the
 * compat line's families use.
 */
export const DASHSCOPE_CN_REALTIME =
  'https://help.aliyun.com/zh/model-studio/realtime.md'
export const DASHSCOPE_CN_DEEP_RESEARCH =
  'https://help.aliyun.com/zh/model-studio/qwen-deep-research.md'

/** The title's `Qwen-…` family, and its lower-case tokens after `qwen`. */
function titleFamily(markdown: string): {
  name: string
  tokens: Array<string>
} {
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? ''
  const name = /\b(Qwen(?:-[A-Za-z]+)+)\b/.exec(title)?.[1]
  if (!name) fail(`page title names no Qwen family: ${title}`)
  return { name, tokens: name.toLowerCase().split('-').slice(1) }
}

/** realtime.md: "通过 WebSocket、WebRTC 使用 Qwen-Omni-Realtime …". */
export function parseDashscopeCnRealtime(markdown: string): Array<string> {
  const { name, tokens } = titleFamily(markdown)
  if (!markdown.includes(`通过 WebSocket、WebRTC 使用 ${name}`))
    fail(`realtime page does not state ${name} is WebSocket/WebRTC`)
  return tokens
}

/** qwen-deep-research.md: "… 也不支持 OpenAI 兼容接口调用。" */
export function parseDashscopeCnDeepResearch(markdown: string): Array<string> {
  const { name, tokens } = titleFamily(markdown)
  if (!/不支持 ?OpenAI ?兼容接口调用/.test(markdown))
    fail(`deep research page does not state ${name} lacks the OpenAI interface`)
  return tokens
}

/** True when the id is a `qwen…` id (any version digits) carrying every family token. */
export function dashscopeFamilyMatches(
  rawId: string,
  tokens: Array<string>,
): boolean {
  const parts = rawId
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '')
  return (
    /^qwen[\d.]*$/.test(parts[0] ?? '') &&
    tokens.every((token) => parts.includes(token))
  )
}
