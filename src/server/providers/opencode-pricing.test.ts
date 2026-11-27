import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import {
  OPENCODE_PRICING_URL,
  parseOpenCodePricing,
} from './opencode-pricing.ts'

/** Excerpt-shaped page. Names and prices are fixtures, not a live snapshot. */
const PAGE = `---
title: "Models"
---

## Endpoints

| Model           | Model ID     | Endpoint                                              | AI SDK Package      |
| --------------- | ------------ | ----------------------------------------------------- | ------------------- |
| Opus            | opus         | \`https://opencode.ai/inference/anthropic/v1/messages\` | \`@ai-sdk/anthropic\` |
| GPT             | gpt          | \`https://opencode.ai/inference/openai/v1/responses\`   | \`@ai-sdk/openai\`    |
| Mistral         | mistral      | \`https://opencode.ai/inference/openai/v1/chat\`        | \`@ai-sdk/openai\`    |
| Jev             | jev          | \`https://opencode.ai/inference/systemone/v1/systemone\` | -                  |
| Pickle          | pickle       | \`https://opencode.ai/inference/openai/v1/chat\`        | \`@ai-sdk/openai\`    |

These packages are for applications.

## Pricing

Below are the prices **per 1M tokens**.

| Model                             | Input           | Output          | Cached Read     | Cached Write |
| --------------------------------- | --------------- | --------------- | --------------- | ------------ |
| Pickle                            | Free            | Free            | Free            | -            |
| Jev                               | $0.042          | Free            | -               | -            |
| Mistral (50% off)                 | ~~$1.36~~ $0.68 | ~~$4.18~~ $2.09 | ~~$0.14~~ $0.07 | -            |
| Opus                              | $4.00           | $20.00          | $0.20           | $5.00        |
| GPT (≤ 272K tokens)               | $5.00           | $30.00          | $0.50           | -            |
| GPT (> 272K tokens)               | $10.00          | $45.00          | $1.00           | -            |

**Mistral:** The 50% discount applies through November 30, 2026.

## Privacy
`

/** The three live Image pricing rows (issue #100007), on the fixture page. */
const IMAGE_PAGE = PAGE.replace(
  '| Pickle          | pickle       |',
  `| GPT Image 2.5 Sunburst | gpt-image-2.5-sunburst | \`https://opencode.ai/inference/openai/v1/images/generations\` | \`@ai-sdk/openai\` |
| Nano Banana 2.1        | gemini-nano-banana-2.1 | \`https://opencode.ai/inference/google/v1beta/models/gemini-nano-banana-2.1:generateContent\` | \`@ai-sdk/google\` |
| Grok Imagine Image 2.0 | grok-imagine-image-2.0 | \`https://opencode.ai/inference/xai/v1/images/generations\` | \`@ai-sdk/xai\` |
| Pickle          | pickle       |`,
).replace(
  '\n## Privacy\n',
  `
### Image pricing

| Model                  | Price                                | Notes                                                                                        |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| GPT Image 2.5 Sunburst | $1.00 / image                        | Plus $8 / $30 per 1M input / output tokens, and $2 per 1M cached input tokens.              |
| Nano Banana 2.1        | $1.50 / $7.50 / $30.00 per 1M tokens | Input / text output / image output. About $0.034 per 1K image, $0.050 per 2K, $0.113 per 4K. |
| Grok Imagine Image 2.0 | $0.04 / image                        | $0.01 per input image; quality and resolution can raise the output price to $0.05\u2013$0.08. |

## Privacy
`,
)

/** Two live Embedding pricing rows (issue #774), on the fixture page. */
const EMBEDDING_PAGE = PAGE.replace(
  '| Pickle          | pickle       |',
  `| text-embedding-3-small | text-embedding-3-small | \`https://opencode.ai/inference/openai/v1/embeddings\` | \`@ai-sdk/openai-compatible\` |
| Qwen3 Embedding 8B     | qwen3-embedding-8b     | \`https://opencode.ai/inference/openai/v1/embeddings\` | \`@ai-sdk/openai-compatible\` |
| Pickle          | pickle       |`,
).replace(
  '\n## Privacy\n',
  `
### Embedding pricing

Embedding models charge for input tokens only. Prices are **per 1M tokens**.

| Model                  | Input |
| ---------------------- | ----- |
| text-embedding-3-small | $0.02 |
| Qwen3 Embedding 8B     | $0.01 |

## Privacy
`,
)

const doc = (text: string) => ({
  text,
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-18T00:00:00.000Z',
})

type Card = RateCard & {
  tables: { rate: Record<string, Record<string, number>> }
}

describe('parseOpenCodePricing', () => {
  it('joins prices to ids, with tiers, discounts and free rows', () => {
    const cards = parseOpenCodePricing(doc(PAGE))
    expect([...cards.keys()].sort()).toEqual([
      'gpt',
      'jev',
      'mistral',
      'opus',
      'pickle',
    ])
    const card = (id: string) => cards.get(id) as Card
    expect(card('opus').source.url).toBe(OPENCODE_PRICING_URL)
    expect(card('opus').tables.rate).toEqual({
      base: {
        input_tokens: 4 / 1e6,
        output_tokens: 20 / 1e6,
        cache_read_tokens: 0.2 / 1e6,
        cache_write_tokens: 5 / 1e6,
      },
    })
    expect(card('gpt').tables.rate).toEqual({
      base: {
        input_tokens: 5 / 1e6,
        output_tokens: 30 / 1e6,
        cache_read_tokens: 0.5 / 1e6,
      },
      '272000': {
        input_tokens: 10 / 1e6,
        output_tokens: 45 / 1e6,
        cache_read_tokens: 1 / 1e6,
      },
    })
    // The billed price, not the struck-through list price.
    expect(card('mistral').tables.rate.base?.input_tokens).toBe(0.68 / 1e6)
    expect(
      price(card('jev'), {}, { input_tokens: 1_000_000, output_tokens: 5 }),
    ).toBeCloseTo(0.042)
    expect(card('pickle')).toMatchObject({ price: 0 })
    expect(
      price(card('pickle'), {}, { input_tokens: 10, output_tokens: 10 }),
    ).toBe(0)
  })

  it('prices stated image rows and stores no card for an unruled band', () => {
    const cards = parseOpenCodePricing(doc(IMAGE_PAGE))
    expect(cards.has('opus')).toBe(true)
    const sun = cards.get('gpt-image-2.5-sunburst') as Card
    const banana = cards.get('gemini-nano-banana-2.1') as Card
    // $0.04 is the floor. Quality and resolution can raise it to $0.05–$0.08
    // with no rule, so the row is unverified rather than billed at $0.04.
    expect(cards.has('grok-imagine-image-2.0')).toBe(false)
    expect(sun.tables.rate).toEqual({
      base: {
        input_tokens: 8 / 1e6,
        output_tokens: 30 / 1e6,
        cache_read_tokens: 2 / 1e6,
      },
    })
    expect(sun.inputs.num_images).toEqual({
      param: 'num_images',
      bound: 'usage',
      kind: 'number',
    })
    // $1.00 per image plus $8 / $30 / $2 per 1M tokens.
    expect(
      price(
        sun,
        {},
        {
          num_images: 1,
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
        },
      ),
    ).toBeCloseTo(41)
    expect(
      price(sun, {}, { num_images: 2, input_tokens: 0, output_tokens: 0 }),
    ).toBeCloseTo(2)
    expect(banana.tables.rate).toEqual({
      base: {
        input_tokens: 1.5 / 1e6,
        output_tokens: 7.5 / 1e6,
        image_output_tokens: 30 / 1e6,
      },
    })
    // The "About $0.034 per 1K" clause is not a resolution price.
    expect(banana.inputs).not.toHaveProperty('resolution')
    expect(
      price(
        banana,
        {},
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          image_output_tokens: 1_000_000,
        },
      ),
    ).toBeCloseTo(39)
  })

  it('prices embedding rows on input tokens only', () => {
    const cards = parseOpenCodePricing(doc(EMBEDDING_PAGE))
    const small = cards.get('text-embedding-3-small') as Card
    expect(small.tables.rate).toEqual({ base: { input_tokens: 0.02 / 1e6 } })
    expect(Object.keys(small.inputs)).toEqual(['input_tokens'])
    expect(price(small, {}, { input_tokens: 1_000_000 })).toBeCloseTo(0.02)
    expect((cards.get('qwen3-embedding-8b') as Card).tables.rate.base).toEqual({
      input_tokens: 0.01 / 1e6,
    })
  })

  it.each([
    [
      'an embedding row removed',
      EMBEDDING_PAGE.replace(/\| Qwen3 Embedding 8B {5}\| \$0\.01 \|\n/, ''),
      /Qwen3 Embedding 8B has an endpoint but no price row/,
    ],
    [
      'a changed embedding header',
      EMBEDDING_PAGE.replace('| Input |', '| Price |'),
      /Embedding pricing header changed/,
    ],
    [
      'an unreadable embedding price',
      EMBEDDING_PAGE.replace('| $0.02 |', '| TBD   |'),
      /unreadable price TBD/,
    ],
    [
      'an embedding model priced in both tables',
      EMBEDDING_PAGE.replace(
        '| Pickle                            | Free',
        '| Qwen3 Embedding 8B                | $0.01           | Free            | -               | -            |\n| Pickle                            | Free',
      ),
      /Qwen3 Embedding 8B is priced twice/,
    ],
    [
      'an unreadable cell',
      PAGE.replace('$4.00 ', 'TBD   '),
      /unreadable price TBD/,
    ],
    [
      'a changed header',
      PAGE.replace('Cached Write', 'Cache Write '),
      /Pricing header changed/,
    ],
    [
      'a row naming no id',
      PAGE.replace('| Opus      ', '| Opus 9    '),
      /names no model id/,
    ],
    [
      'a tier with no pair',
      PAGE.replace(/\| GPT \(> 272K.*\n/, ''),
      /unreadable context tiers/,
    ],
    [
      'mismatched tier thresholds',
      PAGE.replace('≤ 272K', '≤ 200K'),
      /unreadable context tiers/,
    ],
    [
      'a tier that drops a lever',
      PAGE.replace(
        '| $10.00          | $45.00          | $1.00 ',
        '| $10.00          | $45.00          | -     ',
      ),
      /changes the levers/,
    ],
    [
      'a duplicate price row',
      PAGE.replace(/^\| Opus {2}.*\$4\.00.*$/m, (row) => `${row}\n${row}`),
      /duplicate price row/,
    ],
    [
      'no output price',
      PAGE.replace(
        '| $4.00           | $20.00 ',
        '| $4.00           | -      ',
      ),
      /omits input or output/,
    ],
    [
      'a price table that ends early',
      PAGE.replace('\n| GPT (≤', '\n\n| GPT (≤'),
      /has an endpoint but no price row/,
    ],
    [
      'no Pricing section',
      PAGE.replace('## Pricing', '## Prices'),
      /has no Pricing/,
    ],
    [
      'an image endpoint with no image price',
      PAGE.replace(
        '| Pickle          | pickle       |',
        '| Sunburst        | sunburst     | `https://opencode.ai/inference/openai/v1/images/generations` | `@ai-sdk/openai` |\n| Pickle          | pickle       |',
      ),
      /Sunburst has an endpoint but no price row/,
    ],
    [
      'an unreadable image price',
      IMAGE_PAGE.replace('$1.00 / image', '$1.00 / picture'),
      /unreadable image price row GPT Image 2.5 Sunburst/,
    ],
    [
      'a resolution schedule instead of an approximation',
      IMAGE_PAGE.replace(
        'About $0.034 per 1K image, $0.050 per 2K, $0.113 per 4K.',
        '1K is $0.034, 2K is $0.050 and 4K is $0.113.',
      ),
      /unreadable image price row Nano Banana 2.1/,
    ],
    [
      'an unruled band removed from the image table',
      IMAGE_PAGE.replace(/\| Grok Imagine Image 2\.0 \| \$0\.04.*\n/, ''),
      /Grok Imagine Image 2\.0 has an endpoint but no price row/,
    ],
    [
      'a quality rule instead of an unruled band',
      IMAGE_PAGE.replace(
        'quality and resolution can raise the output price to $0.05\u2013$0.08.',
        'low quality is $0.05 and high quality is $0.08.',
      ),
      /unreadable image price row Grok Imagine Image 2.0/,
    ],
    [
      'an image price naming no id',
      IMAGE_PAGE.replace(
        '| GPT Image 2.5 Sunburst | gpt-image-2.5-sunburst |',
        '| GPT Image 9 | gpt-image-2.5-sunburst |',
      ),
      /price row GPT Image 2.5 Sunburst names no model id/,
    ],
    [
      'an image model priced in both tables',
      IMAGE_PAGE.replace(
        '| Pickle                            | Free',
        '| GPT Image 2.5 Sunburst            | $1.00           | $1.00           | -               | -            |\n| Pickle                            | Free',
      ),
      /GPT Image 2.5 Sunburst is priced twice/,
    ],
    [
      'a changed image header',
      IMAGE_PAGE.replace(
        '| Price                                |',
        '| Cost                                 |',
      ),
      /Image pricing header changed/,
    ],
    [
      'an empty table',
      PAGE.replace(/\| (Pickle|Jev|Mistral|Opus|GPT) .*\n/g, ''),
      /unreadable/,
    ],
  ])('throws on %s', (_, text, message) => {
    expect(() => parseOpenCodePricing(doc(text))).toThrow(message)
  })
})
