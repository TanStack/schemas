/** Both Kimi Coding regions are explicitly documented in the same native page. */
import { cachedDocs, docsReport, docsRun, tryDocs } from './model-facts.ts'
import { classifyOpenCodeRoute, routeOnlyChatSpec } from './opencode-routes.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ProviderConfig } from './types.ts'
import {
  KIMI_CODE_MODELS_URL,
  kimiCodeChatRoute,
  parseKimiCodeModels,
} from './kimi-code-docs.ts'
import type { KimiCodeRegion } from './kimi-code-docs.ts'

export function kimiCodeProvider(
  id: string,
  displayName: string,
  region: KimiCodeRegion,
): ProviderConfig {
  return {
    id,
    displayName,
    specSourceUrl: KIMI_CODE_MODELS_URL,
    modelsEndpoint: KIMI_CODE_MODELS_URL,
    defaultDerivation: 'docs-derived',
    bindSyncedRoutesOnly: true,
    // The page states the route, not its request schema (issue #716).
    bindStoredRoutesWithoutSchemas: true,
    async listModels(_env, kv) {
      const doc = await cachedDocs(kv, KIMI_CODE_MODELS_URL, async () => {
        const html = await fetchText(KIMI_CODE_MODELS_URL)
        return { html, hash: await sha256Text(html) }
      })
      const source = {
        derivation: 'docs-derived' as const,
        sourceUrl: KIMI_CODE_MODELS_URL,
        sourceHash: doc.hash,
      }
      const run = docsRun()
      const route = await tryDocs(run, KIMI_CODE_MODELS_URL, async () =>
        kimiCodeChatRoute(doc.html, region),
      )
      return {
        models: parseKimiCodeModels(doc.html, source).map((model) =>
          route
            ? {
                ...model,
                schemaEndpointId: route,
                factSources: {
                  ...model.factSources,
                  schemaEndpointId: {
                    ...source,
                    path: `Base URLs; Chat Completions; ${region} base URL + the protocol's /chat/completions`,
                  },
                },
                absent: { pricing: 'cleared' as const },
              }
            : {
                ...model,
                absent: {
                  pricing: 'cleared' as const,
                  schemaEndpointId: 'unavailable' as const,
                },
              },
        ),
        docsFailures: docsReport(run),
      }
    },
    async fetchSpec() {
      const html = await fetchText(KIMI_CODE_MODELS_URL)
      const hash = await sha256Text(html)
      parseKimiCodeModels(html, {
        derivation: 'docs-derived',
        sourceUrl: KIMI_CODE_MODELS_URL,
        sourceHash: hash,
      })
      return routeOnlyChatSpec([kimiCodeChatRoute(html, region)], {
        url: KIMI_CODE_MODELS_URL,
        hash,
      })
    },
    classify: classifyOpenCodeRoute,
  }
}
