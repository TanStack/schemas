import { describe, expect, it } from 'vitest'

import {
  goTrainsOnRequestData,
  openCodeGoFacts,
  parseGoTraining,
} from './opencode-go-facts.ts'

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

const PRIVACY = `
## Endpoints

| Model | Model ID | Endpoint |
| ----- | -------- | -------- |
| Muse Spark 1.3 Contributor | muse-spark-1.3-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |
| Muse Spark 1.2 Contributor | muse-spark-1.2-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |
| Gemini 4 Argon | gemini-4-argon | \`https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon\` |
| Other Contributor | other-contributor | \`https://opencode.ai/inference/go/openai/v1/responses\` |

## Privacy

| Model | Model training | Data retention |
| ----- | -------------- | -------------- |
| Muse Spark 1.3 Contributor | Yes | Not ZDR |
| Muse Spark 1.2 Contributor | Yes | Not ZDR |
| Gemini 4 Argon | Not used | 0 days |
| Other Contributor | Not used | 0 days |
`

describe('parseGoTraining', () => {
  it('binds Yes to that row’s model id and does not read the suffix', () => {
    const training = parseGoTraining(PRIVACY)
    expect(training.get('muse-spark-1.3-contributor')).toBe(true)
    expect(training.get('muse-spark-1.2-contributor')).toBe(true)
    expect(training.get('gemini-4-argon')).toBe(false)
    expect(training.get('other-contributor')).toBe(false)
    expect(training.has('gemini-4-argon-contributor')).toBe(false)
  })

  it('throws when a privacy training cell is empty', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Mini | mini |

## Privacy

| Model | Model training |
| ----- | -------------- |
| Mini | |
`),
    ).toThrow(/Mini/)
  })

  it('reads training from notes when the privacy table states retention', () => {
    const training = parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Muse Spark 1.3 Contributor | \`muse-spark-1.3-contributor\` |
| Muse Spark 1.2 Contributor | \`muse-spark-1.2-contributor\` |
| Iceman Contributor Free | \`iceman-contributor-free\` |
| Grok 4.7 | \`grok-4.7\` |

## Privacy

See whether each model [trains on your data](https://opencode.ai/console/go#privacy).

| Model                      | Data retention |
| -------------------------- | -------------- |
| Grok 4.7                   | 30 days        |
| Gemini 4 Argon             | 0 days         |
| Muse Spark 1.3 Contributor | Not ZDR        |
| Muse Spark 1.2 Contributor | Not ZDR        |
| DeepSeek V4.1 Flash        | 0 days*        |
| Iceman Contributor Free    | Not ZDR        |

- **Grok 4.7:** ZDR disables important API features that depend on stored data.
- **Muse Spark 1.3 Contributor:** Heavily discounted token pricing in exchange for permission to use your prompts and completions to train future Meta models.
- **Muse Spark 1.2 Contributor:** Heavily discounted token pricing in exchange for permission to use your prompts and completions to train future Meta models.
- **Iceman Contributor Free:** Free for a limited time in exchange for permission to use your prompts and completions to improve the model.
- **DeepSeek:** ZDR agreement is renewed monthly.
`)
    expect(training.get('muse-spark-1.3-contributor')).toBe(true)
    expect(training.get('muse-spark-1.2-contributor')).toBe(true)
    expect(training.get('iceman-contributor-free')).toBe(true)
    expect(training.has('grok-4.7')).toBe(false)
    expect(training.has('gemini-4-argon')).toBe(false)
  })

  it('throws when a retention cell is not a published shape', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Grok 4.7 | grok-4.7 |

## Privacy

| Model | Data retention |
| ----- | -------------- |
| Grok 4.7 | forever |
`),
    ).toThrow(/forever/)
  })

  it('throws when a privacy name has no endpoint id', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Mini | mini |

## Privacy

| Model | Model training |
| ----- | -------------- |
| Missing | Yes |
`),
    ).toThrow(/Missing/)
  })

  it('throws when a note states training in an unknown way', () => {
    expect(() =>
      parseGoTraining(`
## Endpoints

| Model | Model ID |
| ----- | -------- |
| Grok 4.7 | grok-4.7 |

## Privacy

| Model | Data retention |
| ----- | -------------- |
| Grok 4.7 | 30 days |

- **Grok 4.7:** This model trains on prompts.
`),
    ).toThrow(/unknown way/)
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
