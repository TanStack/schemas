import { describe, expect, it } from 'vitest'

import {
  classifyProbeResponse,
  mergeProbedRecords,
  probeBody,
  probeChecks,
} from './chat-completions.ts'
import type { MandatoryRule, ProbeCheck } from './chat-completions.ts'
import responses from './fixtures/probe-responses.json'
import {
  chatProbes,
  probedFactRecords,
  staleProbeCount,
  withProbedFacts,
} from './index.ts'
import { records as groqRecords } from './records/groq.ts'
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
    ).toEqual(['limits', 'replay'])
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

describe('mergeProbedRecords', () => {
  const now = new Date('2026-11-28T00:00:00Z')
  const groq = (over: Partial<ProbedFactRecord>): ProbedFactRecord => ({
    ...record('maxOutput', 65536),
    provider: 'groq',
    id: 'm:maxOutput',
    ...over,
  })

  it("never reads or writes another provider's record with the same id", () => {
    const together = groq({ provider: 'together', verifiedAt: '2026-11-20' })
    const found = groq({ verifiedAt: '2026-11-28' })
    const { records } = mergeProbedRecords('groq', [together], [found], now)
    expect(records).toEqual([found])
  })

  it('keeps a recent same value, re-dates an old one, replaces a new value', () => {
    const recent = groq({ verifiedAt: '2026-11-21' })
    const old = groq({
      id: 'm:contextWindow',
      fact: 'contextWindow',
      value: 8,
      verifiedAt: '2026-08-01',
    })
    const changed = groq({
      id: 'm:reasoning.mandatory',
      fact: 'reasoning.mandatory',
      value: true,
      verifiedAt: '2026-11-21',
    })
    const found = [
      groq({ verifiedAt: '2026-11-28' }),
      { ...old, verifiedAt: '2026-11-28' },
      { ...changed, value: false, verifiedAt: '2026-11-28' },
    ]
    const { records } = mergeProbedRecords(
      'groq',
      [recent, old, changed],
      found,
      now,
    )
    expect(
      records.map((item) => [item.id, item.verifiedAt, item.value]),
    ).toEqual([
      ['m:contextWindow', '2026-11-28', 8],
      ['m:maxOutput', '2026-11-21', 65536],
      ['m:reasoning.mandatory', '2026-11-28', false],
    ])
  })

  it('keeps and lists a stored record the run did not decide', () => {
    const stored = groq({})
    const { records, unconfirmed } = mergeProbedRecords(
      'groq',
      [stored],
      [],
      now,
    )
    expect(records).toEqual([stored])
    expect(unconfirmed).toEqual([stored])
  })

  it('rewrites the committed groq records unchanged from their own evidence', () => {
    // Re-classify each committed record's evidence, then merge as a run would.
    const found = groqRecords.map((item) => {
      const check: ProbeCheck =
        item.fact === 'maxOutput'
          ? 'limits'
          : item.fact === 'replayReasoningContent'
            ? 'replay'
            : 'off'
      const outcome = classifyProbeResponse(
        check,
        item.evidence.status,
        JSON.stringify({ error: { message: item.evidence.message } }),
        'groq',
      )
      expect(outcome).toMatchObject({ fact: item.fact, value: item.value })
      return item
    })
    const { records } = mergeProbedRecords(
      'groq',
      probedFactRecords,
      found,
      new Date('2026-11-21T00:00:00Z'),
    )
    expect(records).toEqual(groqRecords)
  })
})
