import { describe, expect, it } from 'vitest'

import { goTrainsOnRequestData, openCodeGoFacts } from './opencode-go-facts.ts'

describe('openCodeGoFacts', () => {
  it('requires the session header and User-Agent on every Go row', () => {
    const facts = openCodeGoFacts('opencode-go', 'glm-5.2')
    expect(facts.requiredRequestHeaders?.map((header) => header.name)).toEqual([
      'x-opencode-session',
      'User-Agent',
    ])
    expect(facts.trainsOnRequestData).toBeNull()
    expect(facts.factSources.requiredRequestHeaders).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: 'https://opencode.ai/docs/console/go/',
    })
    expect(facts.factSources.trainsOnRequestData).toBeUndefined()
  })

  it('sets training only on the id whose probe stated it', () => {
    const argon = openCodeGoFacts('opencode-go', 'gemini-4-argon-contributor')
    expect(argon.trainsOnRequestData).toBe(true)
    expect(argon.factSources.trainsOnRequestData).toMatchObject({
      derivation: 'probe-verified',
      verifiedAt: '2026-10-23',
    })
    expect(
      openCodeGoFacts('opencode-go', 'muse-spark-1.3-contributor')
        .trainsOnRequestData,
    ).toBeNull()
    expect(openCodeGoFacts('opencode', 'gemini-4-argon-contributor')).toEqual({
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    })
  })
})

describe('goTrainsOnRequestData', () => {
  it('reads the listing boolean and does not treat false as missing', () => {
    const training = goTrainsOnRequestData({
      object: 'list',
      data: [
        { id: 'muse-spark-1.3-contributor', go: { training: true } },
        { id: 'grok-4.7', go: { training: false } },
      ],
    })
    expect(training.get('muse-spark-1.3-contributor')).toBe(true)
    expect(training.get('grok-4.7')).toBe(false)
  })

  it('throws when go.training is missing or not a boolean', () => {
    expect(() =>
      goTrainsOnRequestData({
        object: 'list',
        data: [{ id: 'grok-4.7', go: { training: '30 days' } }],
      }),
    ).toThrow(/grok-4\.7/)
  })
})
