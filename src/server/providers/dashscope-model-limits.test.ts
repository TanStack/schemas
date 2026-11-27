import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  dashscopeDocText,
  dashscopeModelPageUrl,
  loadDashscopeModelLimits,
  parseDashscopeModelLimits,
} from './dashscope-model-limits.ts'

/** The rendered qwen3-omni-flash.md page, fetched 2026-10-29 (issue #520). */
const OMNI_PAGE = readFileSync(
  new URL('./fixtures/dashscope/qwen3-omni-flash.html', import.meta.url),
  'utf8',
)

/** Context limits from qwen3-omni-flash.md, checked 2026-10-08. */
const OMNI_FIXTURE = `# qwen3-omni-flash

## Context Limits <span id="h-4b8ebeae72" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>49152</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Input Length (Thinking Mode)</p></td><td><p>16384</p></td></tr><tr><td><p>Max Output Length (Thinking Mode)</p></td><td><p>16384</p></td><td><p>Max Chain-of-Thought Length</p></td><td><p>32768</p></td></tr></tbody></table>

## Pricing <span id="h-d72e94e06d" />

### qwen3-omni-flash-2025-09-15 <span id="h-0c5c74dc20" />

#### Model Capabilities <span id="h-eca28b5fa5" />

<table><thead><tr><th>Capability</th><th>Support</th></tr></thead><tbody><tr><td><p>Function Calling</p></td><td><p>Supported</p></td></tr></tbody></table>

#### Context Limits <span id="h-8a43bf5ab2" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>49152</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Input Length (Thinking Mode)</p></td><td><p>16384</p></td></tr></tbody></table>
`

/** Context limits from qwen3-8-omni-flash-realtime.md, checked 2026-10-08. */
const REALTIME_FIXTURE = `# qwen3.8-omni-flash-realtime

## Model capabilities

| Capability | Support | Capability | Support |
| --- | --- | --- | --- |
| Input modalities | Text, streaming audio, and video | Output modalities | Text and audio |

## Context limits

| Parameter                  | Value                                   | Parameter             | Value                                    |
| -------------------------- | --------------------------------------- | --------------------- | ---------------------------------------- |
| Maximum total input tokens | 196608                                  | Audio history         | Up to 100 turns and 600 seconds in total |
| Video history              | Up to 50 turns and 240 seconds in total | Maximum output tokens | 65536                                    |

## Model pricing
`

/** Context limits from decision-model-preview.md, checked 2026-10-08. */
const DECISION_FIXTURE = `# decision-model-preview

## Context Limits <span id="h-dm-ctx" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>65,536</p></td><td><p>Max Output Length</p></td><td><p>0</p></td></tr><tr><td><p>Context Window</p></td><td><p>65,536</p></td><td /><td /></tr></tbody></table>
`

/** decision-model.md, fetched 2026-11-27 (#772): an overview page. */
const DECISION_INDEX = `# Decision Model

> Overview of Alibaba Cloud Model Studio decision models.

- [Decision Model API Reference](/help/en/model-studio/decision-model-api): Call via the System One protocol.
- [decision-model Model Info](/help/en/model-studio/decision-model-stable): Model capabilities, context limits, pricing, and rate limits.
`

/** decision-model-stable.md, fetched 2026-11-27 (#772), trimmed. */
const DECISION_STABLE = `# decision-model

## Model Capabilities <span id="h-dm-cap" />

<table><thead><tr><th>Capability</th><th>Support</th><th>Capability</th><th>Support</th></tr></thead><tbody><tr><td><p>Input Modality</p></td><td><p><strong>Text, image</strong></p></td><td><p>Output Modality</p></td><td><p><strong>Text (structured decision result)</strong></p></td></tr></tbody></table>

## Context Limits <span id="h-dm-ctx" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>268,288</p></td><td><p>Max Output Length</p></td><td><p>—</p></td></tr><tr><td><p>Context Window</p></td><td><p>268,288</p></td><td /><td /></tr></tbody></table>

## Pricing <span id="h-dm-price" />
`

/** qwen-audio-3-1-live.md, fetched 2026-11-27 (#772), trimmed: no Context limits section. */
const AUDIO_LIVE = `# qwen-audio-3.1-live

## Model capabilities

| Capability        | Supported     | Capability        | Supported     |
| ----------------- | ------------- | ----------------- | ------------- |
| Input Modalities  | Text, Audio   | Output Modalities | Text, Audio   |

## Input limits

The combined length of system instructions and function configuration text for the frontend model is limited to at most 65,536 tokens.

## Model Pricing
`

describe('dashscope model limits', () => {
  it('reads context and non-thinking max output, including snapshot sections', () => {
    const models = parseDashscopeModelLimits(OMNI_FIXTURE)
    expect(models['qwen3-omni-flash']).toEqual({
      contextWindow: 65536,
      maxOutput: 16384,
    })
    expect(models['qwen3-omni-flash-2025-09-15']).toEqual({
      contextWindow: 65536,
      maxOutput: 16384,
    })
  })

  it('does not treat maximum input as the context window', () => {
    expect(parseDashscopeModelLimits(REALTIME_FIXTURE)).toEqual({
      'qwen3.8-omni-flash-realtime': {
        contextWindow: null,
        maxOutput: 65536,
      },
    })
  })

  it('keeps a published max output of zero', () => {
    expect(parseDashscopeModelLimits(DECISION_FIXTURE)).toEqual({
      'decision-model-preview': { contextWindow: 65536, maxOutput: 0 },
    })
  })

  it('throws when the page has no context-limit row', () => {
    expect(() => parseDashscopeModelLimits('# qwen-plus\n\nno table')).toThrow(
      /parsed 0 context-limit rows/,
    )
  })

  it('gives a model page with no Context limits section null limits', () => {
    expect(parseDashscopeModelLimits(AUDIO_LIVE)).toEqual({
      'qwen-audio-3.1-live': { contextWindow: null, maxOutput: null },
    })
  })

  it('throws when the limits table sits under a renamed heading', () => {
    expect(() =>
      parseDashscopeModelLimits(
        OMNI_FIXTURE.replaceAll('Context Limits', 'Token Limits'),
      ),
    ).toThrow(/parsed 0 context-limit rows/)
  })

  it('still throws when a Context limits section parses nothing', () => {
    expect(() =>
      parseDashscopeModelLimits(
        `${AUDIO_LIVE}\n## Context limits\n\nSee the table below.\n`,
      ),
    ).toThrow(/parsed 0 context-limit rows/)
  })

  it('follows an overview page to the model info page it links', async () => {
    const fetched: Array<string> = []
    const doc = await loadDashscopeModelLimits(DECISION_INDEX, (url) => {
      fetched.push(url)
      return Promise.resolve(DECISION_STABLE)
    })
    expect(fetched).toEqual([
      'https://www.alibabacloud.com/help/en/model-studio/decision-model-stable.md',
    ])
    expect(doc.sourceUrl).toBe(fetched[0])
    expect(doc.models).toEqual({
      'decision-model': { contextWindow: 268288, maxOutput: null },
    })
  })

  it('throws on an overview page when not given a fetch', async () => {
    await expect(loadDashscopeModelLimits(DECISION_INDEX)).rejects.toThrow(
      /parsed 0 context-limit rows/,
    )
  })

  it('reads the rendered help page the .md URL serves since 2026-10-27', async () => {
    const doc = await loadDashscopeModelLimits(OMNI_PAGE)
    expect(doc.models).toEqual({
      'qwen3-omni-flash': { contextWindow: 65536, maxOutput: 16384 },
    })
    // The page's traceid changes per request; the hash covers the article.
    expect(doc.sourceHash).toBe(
      (
        await loadDashscopeModelLimits(
          OMNI_PAGE.replace(/traceid="[^"]*"/, 'traceid="other"'),
        )
      ).sourceHash,
    )
  })

  it('turns the article back into the markdown shape, keeping tables', () => {
    const page = `<!DOCTYPE html><html traceid="x"><head><title>t</title></head><body>
<h1 class="page-title">Alibaba Cloud Model Studio:qwen-plus</h1>
<article class="product-description markdown-body"><div>
<p>Use the <code>thinking_budget</code> parameter &amp; see <a href="/x">docs</a>.</p>
<h2 id="s">Supported Models <span id="a"></span></h2>
<section><h4>Qwen3</h4><ul><li><strong>Plus</strong> (Hybrid thinking mode): qwen-plus, qwen-plus-latest</li></ul></section>
<pre class="pre codeblock"><code>model=&quot;qwen-plus&quot;</code></pre>
<h2>Context Limits</h2>
<table><tbody><tr><td><p>Context Window</p></td><td><p>1,000,000</p></td></tr></tbody></table>
</div></article><div class="nav-footer"><h2>Feedback</h2></div></body></html>`
    expect(dashscopeDocText(page, 'x')).toBe(`# qwen-plus

Use the \`thinking_budget\` parameter & see docs.

## Supported Models

#### Qwen3

Plus (Hybrid thinking mode): qwen-plus, qwen-plus-latest

\`\`\`
model="qwen-plus"
\`\`\`

## Context Limits

<table><tbody><tr><td><p>Context Window</p></td><td><p>1,000,000</p></td></tr></tbody></table>
`)
    expect(parseDashscopeModelLimits(dashscopeDocText(page, 'x'))).toEqual({
      'qwen-plus': { contextWindow: 1000000, maxOutput: null },
    })
    expect(dashscopeDocText('# md\n', 'x')).toBe('# md\n')
  })

  it('rejects an HTML shell', async () => {
    await expect(
      loadDashscopeModelLimits(
        '<!DOCTYPE html><html><head>\n<title>Access denied</title></head></html>',
      ),
    ).rejects.toThrow(
      /not markdown \(title: Access denied\): <!DOCTYPE html><html><head> <title>/,
    )
  })

  it('points a dated snapshot at the stable model page', () => {
    expect(dashscopeModelPageUrl('qwen3-omni-flash-2025-09-15')).toBe(
      'https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash.md',
    )
    expect(dashscopeModelPageUrl('qwen3.8-omni-flash-realtime')).toBe(
      'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime.md',
    )
  })
})
