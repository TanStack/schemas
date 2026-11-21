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
