import { describe, expect, it } from 'vitest'

import { makerNamesProvider } from '#/server/first-party.ts'
import { openRouterVariantUpstream } from '#/server/providers/openrouter.ts'
import { originNameKey } from './origin-key.ts'

describe('originNameKey (#719)', () => {
  const prefixes = new Set(['anthropic', 'google', 'mistral', 'meta'])
  it.each([
    ['claude-fable-5', 'claude-fable-5'],
    ['Claude-Fable-5', 'claude-fable-5'],
    ['anthropic/claude-opus-4.5', 'claude-opus-4-5'],
    ['google/gemma-4-31B-it', 'gemma-4-31b-it'],
    // Bedrock form: the maker before a dot, Bedrock's version after.
    ['anthropic.claude-fable-5-v1:0', 'claude-fable-5'],
    ['mistral.mistral-large-2407-v1:0', 'mistral-large-2407'],
    // A maker's own version and an unknown prefix stay.
    ['cohere.embed-v4:0', 'cohere-embed-v4:0'],
    ['meta-llama/llama-9-70b', 'meta-llama/llama-9-70b'],
    ['accounts/fireworks/models/x', 'accounts/fireworks/models/x'],
    // Only one prefix is dropped, and no Bedrock version off a slash id.
    ['anthropic/anthropic/x-v1:0', 'anthropic/x-v1:0'],
    ['gpt-4.1', 'gpt-4-1'],
  ])('%s → %s', (rawId, key) => {
    expect(originNameKey(rawId, prefixes)).toBe(key)
  })
})

describe('makerNamesProvider (#719)', () => {
  const gemini = new Set(['gemini', 'google', 'googleaistudio'])
  it.each([
    ['Google DeepMind', gemini, true],
    ['Google', gemini, true],
    ['Meta', gemini, false],
    ['Z.ai', new Set(['mistral']), false],
    ['Mistral AI', new Set(['mistral']), true],
    ['ByteDance', new Set(['byteplus', 'bytedance']), true],
    ['DeepSeek', new Set(['byteplus', 'bytedance']), false],
    // Groq claims no namespace: every maker its listing names is another.
    ['Meta', new Set(['groq']), false],
    ['meta-llama', new Set(['groq']), false],
    ['OpenAI', new Set(['groq']), false],
    ['Alibaba Cloud', new Set(['groq']), false],
    ['Z.ai', new Set(['groq']), false],
    // The same names at the provider that is the maker.
    ['meta-llama', new Set(['meta']), true],
    ['Alibaba Cloud', new Set(['dashscope', 'alibaba', 'qwen']), true],
    ['Z.ai', new Set(['zai', 'zaiorg']), true],
  ] as const)('%s', (maker, names, expected) => {
    expect(makerNamesProvider(maker, names)).toBe(expected)
  })
})

describe('openRouterVariantUpstream (#719)', () => {
  it('states the base of a variant only when the listing gives both one canonical_slug', () => {
    const out = openRouterVariantUpstream([
      { id: 'anthropic/claude-opus-5', canonical_slug: 'anthropic/opus-5-1' },
      {
        id: 'anthropic/claude-opus-5:batch',
        canonical_slug: 'anthropic/opus-5-1',
      },
      { id: 'openai/gpt-9:free', canonical_slug: 'openai/gpt-9-free' },
      { id: 'openai/gpt-9', canonical_slug: 'openai/gpt-9-2026' },
      { id: 'qwen/q-1:free', canonical_slug: 'qwen/q-1' },
    ])
    expect([...out.keys()]).toEqual(['anthropic/claude-opus-5:batch'])
    expect(out.get('anthropic/claude-opus-5:batch')).toEqual({
      providerNamespace: 'anthropic',
      rawId: 'claude-opus-5',
      source: {
        derivation: 'listing',
        sourceUrl: 'https://openrouter.ai/api/v1/models',
        path: 'data[].canonical_slug',
        variant: 'batch',
      },
    })
  })
})
