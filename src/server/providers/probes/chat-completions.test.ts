import { describe, expect, it } from 'vitest'

import { classifyProbeResponse, probeBody } from './chat-completions.ts'
import type { ProbeCheck } from './chat-completions.ts'
import responses from './fixtures/probe-responses.json'
import { staleProbeCount, withProbedFacts } from './index.ts'
import type { ProbedFactRecord } from './types.ts'

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

describe('classifyProbeResponse', () => {
  it.each(responses)('$name', ({ name, check, status, body }) => {
    const outcome = classifyProbeResponse(check as ProbeCheck, status, body)
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

  it('reads the vLLM context length wording', () => {
    // vLLM's own error text (serving engine), not a live capture.
    const body = JSON.stringify({
      object: 'error',
      message:
        "This model's maximum context length is 32768 tokens. However, you requested 10000009 tokens (9 in the messages, 10000000 in the completion). Please reduce the length of the messages or completion.",
    })
    expect(classifyProbeResponse('limits', 400, body)).toMatchObject({
      fact: 'contextWindow',
      value: 32768,
    })
  })

  it('records nothing when the level list has an off value', () => {
    const body = JSON.stringify({
      error: {
        message: '`reasoning_effort` must be one of `none`, `low` or `high`',
      },
    })
    expect(classifyProbeResponse('off', 400, body)).toHaveProperty('undecided')
  })

  it('keeps every request to one output token but the limits check', () => {
    expect(probeBody('replay', 'm').max_tokens).toBe(1)
    expect(probeBody('off', 'm').max_tokens).toBe(1)
    expect(probeBody('limits', 'm').stream).toBe(true)
  })
})

function record(
  fact: ProbedFactRecord['fact'],
  value: number | boolean,
): ProbedFactRecord {
  return {
    id: `m:${fact}`,
    provider: 'p',
    model: 'm',
    fact,
    value,
    route: 'v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'test',
    request: { url: 'https://example.com', body: {} },
    evidence: { status: 400, message: 'x' },
  }
}

describe('withProbedFacts', () => {
  const records = [
    record('maxOutput', 65536),
    record('contextWindow', 131072),
    record('replayReasoningContent', false),
    record('reasoning.mandatory', true),
  ]
  const source = (id: string) => ({
    derivation: 'probe-verified',
    verifiedAt: '2026-11-21',
    sourceUrl: `src/server/providers/probes/records/p.ts#m:${id}`,
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

  it('counts the committed groq records as current', () => {
    expect(staleProbeCount('groq', new Date('2026-11-22T00:00:00Z'))).toBe(0)
    expect(staleProbeCount('groq', new Date('2027-03-01T00:00:00Z'))).toBe(6)
  })
})
