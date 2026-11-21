import { describe, expect, it } from 'vitest'

import {
  classifyProbeResponse,
  probeBody,
  probeChecks,
  redactKey,
} from './chat-completions.ts'
import type { MandatoryRule, ProbeCheck } from './chat-completions.ts'
import responses from './fixtures/probe-responses.json'
import { chatProbes, withProbedFacts } from './index.ts'
import type { ServedProbeFact } from './types.ts'

/**
 * Real bodies from live probe calls on 2026-11-21 (account ids and a
 * masked key fragment replaced). Every one that is not listed in
 * `DECIDED` must record nothing.
 */
const DECIDED: Record<string, unknown> = {
  'openai-limits-gpt-4o-mini': { fact: 'maxOutput', value: 16384 },
  'groq-limits-openai_gpt-oss-20b': { fact: 'maxOutput', value: 65536 },
  'groq-replay-openai_gpt-oss-20b': {
    fact: 'replayReasoningContent',
    value: false,
  },
  'mistral-replay-codestral-2508': {
    fact: 'replayReasoningContent',
    value: false,
  },
  'groq-off-openai_gpt-oss-safeguard-20b': {
    fact: 'reasoning.mandatory',
    value: true,
  },
  'openai-off-gpt-5-mini': { fact: 'reasoning.mandatory', value: true },
}

/** The `mandatoryRule` each captured provider would opt in with. */
const RULES: Record<string, MandatoryRule> = { groq: 'groq', openai: 'openai' }

describe('classifyProbeResponse', () => {
  it.each(responses)('$name', ({ name, check, status, body }) => {
    const rule = RULES[name.split('-')[0]!]
    const outcome = classifyProbeResponse(
      check as ProbeCheck,
      status,
      body,
      rule,
    )
    const expected = DECIDED[name]
    if (expected) expect(outcome).toMatchObject(expected)
    else expect(outcome).toHaveProperty('undecided')
  })

  it('covers every decided fixture', () => {
    const names = new Set(responses.map((item) => item.name))
    for (const name of Object.keys(DECIDED)) expect(names).toContain(name)
  })

  it('does not read a cap that equals the context window as maxOutput', () => {
    // Fireworks: 1048576 is the model's context window, not its output cap.
    const fireworks = responses.find((item) =>
      item.name.includes('fireworks-limits-accounts_fireworks_models_deepseek'),
    )!
    expect(
      classifyProbeResponse('limits', fireworks.status, fireworks.body),
    ).toEqual({
      undecided: expect.stringContaining('names no limit') as string,
    })
  })

  it('reads a provider level list only under its own opt-in', () => {
    const groq = responses.find(
      (item) => item.name === 'groq-off-openai_gpt-oss-safeguard-20b',
    )!
    // A shared enum or a gateway forwarding Groq's 400 states nothing.
    expect(classifyProbeResponse('off', groq.status, groq.body)).toHaveProperty(
      'undecided',
    )
    expect(
      classifyProbeResponse('off', groq.status, groq.body, 'openai'),
    ).toHaveProperty('undecided')
    expect(
      probeChecks({ ...chatProbes[0]!, mandatoryRule: undefined }),
    ).toEqual(['limits'])
  })

  it('records nothing when the level list has an off value', () => {
    const body = JSON.stringify({
      error: {
        message: '`reasoning_effort` must be one of `none`, `low` or `high`',
      },
    })
    expect(classifyProbeResponse('off', 400, body, 'groq')).toHaveProperty(
      'undecided',
    )
  })

  it('keeps every request to one output token but the limits check', () => {
    expect(probeBody('replay', 'm').max_tokens).toBe(1)
    expect(probeBody('off', 'm').max_tokens).toBe(1)
    expect(probeBody('limits', 'm').stream).toBe(true)
  })

  it('redacts the key and its leading and trailing fragments', () => {
    const key = 'sk-proj-abcdef0123456789xyzXYZ'
    expect(
      redactKey(`bad key ${key}; also sk-proj-…6789xyzXYZ`, key),
    ).not.toMatch(/sk-proj-|xyzXYZ/)
  })
})

function record(
  fact: ServedProbeFact['fact'],
  value: number | boolean,
): ServedProbeFact {
  return {
    provider: 'p',
    model: 'm',
    fact,
    value,
    route: 'v1/chat/completions',
    verifiedAt: '2026-11-21',
    sourceUrl: 'https://example.com/v1/chat/completions',
  }
}

describe('withProbedFacts', () => {
  const records = [
    record('maxOutput', 65536),
    record('contextWindow', 131072),
    record('replayReasoningContent', false),
    record('reasoning.mandatory', true),
  ]
  const source = (_fact: string) => ({
    derivation: 'probe-verified',
    verifiedAt: '2026-11-21',
    sourceUrl: 'https://example.com/v1/chat/completions',
  })

  it('fills empty facts with a dated probe-verified source', () => {
    const next = withProbedFacts(
      {
        rawId: 'm',
        maxOutput: null,
        reasoning: { mode: 'effort', mandatory: null, efforts: ['low'] },
      },
      'p',
      'v1/chat/completions',
      null,
      records,
    )
    expect(next.maxOutput).toBe(65536)
    expect(next.contextWindow).toBe(131072)
    expect(next.requestMap?.replayReasoningContent).toBe(false)
    expect(next.reasoning?.mandatory).toBe(true)
    expect(next.factSources).toEqual({
      maxOutput: source('maxOutput'),
      contextWindow: source('contextWindow'),
      requestMapFields: {
        replayReasoningContent: source('replayReasoningContent'),
      },
      reasoningMandatory: source('reasoning.mandatory'),
    })
  })

  it('never replaces a stated value, another route, or another model', () => {
    const stated = {
      rawId: 'm',
      maxOutput: 8192,
      contextWindow: 32768,
      reasoning: { mode: 'effort' as const, mandatory: false },
    }
    const kept = withProbedFacts(stated, 'p', 'v1/chat/completions', null, [
      record('maxOutput', 65536),
      record('contextWindow', 131072),
      record('reasoning.mandatory', true),
    ])
    expect(kept.maxOutput).toBe(8192)
    expect(kept.contextWindow).toBe(32768)
    expect(kept.reasoning?.mandatory).toBe(false)
    const empty = { rawId: 'm', maxOutput: null }
    expect(withProbedFacts(empty, 'p', 'other', null, records)).toBe(empty)
    expect(
      withProbedFacts(
        { rawId: 'm-2' },
        'p',
        'v1/chat/completions',
        null,
        records,
      ),
    ).toEqual({ rawId: 'm-2' })
  })

  it('leaves a non-effort reasoning row and a level list with none alone', () => {
    const budget = withProbedFacts(
      { rawId: 'm', reasoning: { mode: 'budget', mandatory: null } },
      'p',
      'v1/chat/completions',
      null,
      [record('reasoning.mandatory', true)],
    )
    expect(budget.reasoning?.mandatory).toBeNull()
    const withNone = withProbedFacts(
      {
        rawId: 'm',
        reasoning: {
          mode: 'effort',
          mandatory: null,
          efforts: ['none', 'low'],
        },
      },
      'p',
      'v1/chat/completions',
      null,
      [record('reasoning.mandatory', true)],
    )
    expect(withNone.reasoning?.mandatory).toBeNull()
  })
})
