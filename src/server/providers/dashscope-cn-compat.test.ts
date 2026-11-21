import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dashscopeFamilyMatches,
  parseDashscopeCnCompat,
  parseDashscopeCnDeepResearch,
  parseDashscopeCnRealtime,
} from './dashscope-cn-compat.ts'

// help.aliyun.com/zh/model-studio/*.md, captured 2026-11-21. realtime.md
// and qwen-deep-research.md are trimmed to their opening sections.
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/dashscope-cn/${name}`, import.meta.url),
    'utf8',
  )
const page = fixture('compatibility-of-openai-with-dashscope.md.txt')

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
  it('reads the families realtime.md and qwen-deep-research.md put on another protocol', () => {
    const realtime = fixture('realtime.md.txt')
    const deep = fixture('qwen-deep-research.md.txt')
    expect(parseDashscopeCnRealtime(realtime)).toEqual(['omni', 'realtime'])
    expect(parseDashscopeCnDeepResearch(deep)).toEqual(['deep', 'research'])
    expect(
      dashscopeFamilyMatches('qwen3.8-omni-flash-realtime', [
        'omni',
        'realtime',
      ]),
    ).toBe(true)
    expect(
      dashscopeFamilyMatches('qwen3-omni-flash', ['omni', 'realtime']),
    ).toBe(false)
    expect(
      dashscopeFamilyMatches('qwen-deep-research-2025-12-15', [
        'deep',
        'research',
      ]),
    ).toBe(true)
  })
  it('throws when an exclusion page changes its protocol statement', () => {
    expect(() =>
      parseDashscopeCnRealtime(
        fixture('realtime.md.txt').replace(
          '通过 WebSocket、WebRTC 使用',
          '使用',
        ),
      ),
    ).toThrow(/WebSocket\/WebRTC/)
    expect(() =>
      parseDashscopeCnDeepResearch(
        fixture('qwen-deep-research.md.txt').replace(
          '也不支持 OpenAI 兼容接口调用',
          '也支持 OpenAI 兼容接口调用',
        ),
      ),
    ).toThrow(/OpenAI interface/)
  })
  it('throws on a supported models item it cannot read', () => {
    expect(() =>
      parseDashscopeCnCompat(
        page.replace('、MiniMax（', '、全部第三方模型、MiniMax（'),
      ),
    ).toThrow(/unreadable supported models line/)
  })
})
