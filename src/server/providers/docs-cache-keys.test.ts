import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Two loaders that cache different shapes under one docs key break each
// other on every warm poll: BytePlus makers and Tool use both cached the
// model list as `docs:v46:<url>` (2026-11-21). A second parse of a page
// takes its own `#suffix`. ponytail: matches key expressions as written, so
// two constants with the same URL, or a helper's `url` parameter, pass.
const SAME_SHAPE = new Set([
  // nvidia.ts and nvidia-sitemap.ts both cache parseNvidiaInferSitemap.
  'NVIDIA_SITEMAP_URL',
])

describe('docs cache keys', () => {
  it('gives each cached parse of a page its own key', () => {
    const dir = new URL('.', import.meta.url)
    const sites = new Map<string, string[]>()
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    for (const file of files) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const src = readFileSync(new URL(file, dir), 'utf8')
      const calls = src.matchAll(
        /\b(?:cached|cachedDocs|cachedGoogleDocs)\s*(?:<[^>()]*>)?\(\s*[^,()]+?\s*,\s*([^,]+?)\s*,/g,
      )
      for (const [, key = ''] of calls) {
        // A helper's parameter (or its declaration, `url: string`) is the
        // caller's key, not a key of its own.
        if (/^[a-z]\w*(:|$)/.test(key) || SAME_SHAPE.has(key)) continue
        sites.set(key, [...(sites.get(key) ?? []), file])
      }
    }
    const shared = [...sites].filter(([, where]) => where.length > 1)
    expect(shared).toEqual([])
  })
})
