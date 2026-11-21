import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDashscopeCnCompat } from './dashscope-cn-compat.ts'

// help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope.md, 2026-11-21.
const page = readFileSync(
  new URL(
    './fixtures/dashscope-cn/compatibility-of-openai-with-dashscope.md.txt',
    import.meta.url,
  ),
  'utf8',
)

describe('parseDashscopeCnCompat (issue #716)', () => {
  it('reads the Beijing chat endpoint and the supported models line', () => {
    expect(parseDashscopeCnCompat(page)).toEqual({
      route: 'compatible-mode/v1/chat/completions',
      scope: {
        qwenLlm: true,
        qwenKinds: ['vl', 'coder', 'omni', 'math'],
        families: ['deepseek', 'kimi', 'glm', 'minimax'],
        deny: ['audio'],
      },
    })
  })
  it('throws when the Beijing endpoint is gone', () => {
    expect(() =>
      parseDashscopeCnCompat(page.replaceAll('北京：POST', '北京：GET')),
    ).toThrow(/Beijing chat endpoint/)
  })
  it('throws on a supported models item it cannot read', () => {
    expect(() =>
      parseDashscopeCnCompat(
        page.replace('、MiniMax（', '、全部第三方模型、MiniMax（'),
      ),
    ).toThrow(/unreadable supported models line/)
  })
})
