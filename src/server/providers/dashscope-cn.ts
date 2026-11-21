import { cachedDocs, docsReport, docsRun, tryDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, ProviderConfig } from './types.ts'
import { dashscopeCompatCovers } from './dashscope-compat.ts'
import {
  DASHSCOPE_CN_COMPAT,
  parseDashscopeCnCompat,
} from './dashscope-cn-compat.ts'
import type { DashscopeCnCompat } from './dashscope-cn-compat.ts'
import { classifyOpenCodeRoute, routeOnlyChatSpec } from './opencode-routes.ts'
import {
  applyCnCardFacts,
  applyCnCatalog,
  applyCnTextFacts,
  cnPriceModels,
  DASHSCOPE_CN_MODELS,
  DASHSCOPE_CN_PRICES,
} from './dashscope-cn-docs.ts'
import type { CnDoc } from './dashscope-cn-docs.ts'

export const DASHSCOPE_CN_TEXT =
  'https://help.aliyun.com/zh/model-studio/text-generation-model.md'
export const DASHSCOPE_CN_FLASH =
  'https://help.aliyun.com/zh/model-studio/qwen-flash.md'
const EXPECTED_TITLES = [
  '模型调用价格',
  '选择模型',
  '文本生成与视觉理解',
  'qwen-flash',
] as const
const URLS = [
  DASHSCOPE_CN_PRICES,
  DASHSCOPE_CN_MODELS,
  DASHSCOPE_CN_TEXT,
  DASHSCOPE_CN_FLASH,
] as const
async function load(kv?: KVNamespace) {
  return cachedDocs(kv, DASHSCOPE_CN_PRICES, async () => {
    const docs = await Promise.all(
      URLS.map(async (url, index): Promise<CnDoc> => {
        const text = await fetchText(url, {
          signal: AbortSignal.timeout(30_000),
        })
        if (
          /<!doctype|<html\b/i.test(text) ||
          /^#\s+([^\r\n]+)/m.exec(text)?.[1]?.trim() !== EXPECTED_TITLES[index]
        )
          throw new Error(`dashscope-cn: malformed native source ${url}`)
        return { text, url, hash: await sha256Text(text) }
      }),
    )
    const [prices, catalog, textModels, flash] = docs
    if (!prices || !catalog || !textModels || !flash)
      throw new Error('dashscope-cn: missing native source')
    const models = applyCnCardFacts(
      applyCnTextFacts(
        applyCnCatalog(cnPriceModels(prices), catalog),
        textModels,
      ),
      flash,
    )
    return { docs, models }
  })
}
async function loadCompat(): Promise<DashscopeCnCompat & { hash: string }> {
  const text = await fetchText(DASHSCOPE_CN_COMPAT, {
    signal: AbortSignal.timeout(30_000),
  })
  return { ...parseDashscopeCnCompat(text), hash: await sha256Text(text) }
}

/** Binds a chat row the compat page's supported-models line names. */
function withCompatRoute(
  model: ModelInfo,
  compat: (DashscopeCnCompat & { hash: string }) | null,
): ModelInfo {
  if (model.activity !== 'chat') return model
  if (!compat)
    return {
      ...model,
      absent: { ...model.absent, schemaEndpointId: 'unavailable' },
    }
  if (!dashscopeCompatCovers(model.rawId, compat.scope)) return model
  return {
    ...model,
    schemaEndpointId: compat.route,
    factSources: {
      ...model.factSources,
      schemaEndpointId: {
        derivation: 'docs-derived',
        sourceUrl: DASHSCOPE_CN_COMPAT,
        sourceHash: compat.hash,
        path: '完整访问endpoint 北京; 支持的模型',
      },
    },
  }
}

export const provider: ProviderConfig = {
  id: 'dashscope-cn',
  displayName: 'Alibaba Cloud Model Studio (China)',
  defaultDerivation: 'docs-derived',
  modelsEndpoint: DASHSCOPE_CN_MODELS,
  specSourceUrl: DASHSCOPE_CN_MODELS,
  bindSyncedRoutesOnly: true,
  // The compat page states the chat route, not its body schema (#716).
  bindStoredRoutesWithoutSchemas: true,
  async listModels(_env, kv) {
    const { models } = await load(kv)
    const run = docsRun()
    const compat = await tryDocs(run, DASHSCOPE_CN_COMPAT, (cached) =>
      cached(kv, `${DASHSCOPE_CN_COMPAT}#route`, loadCompat),
    )
    return {
      models: models.map((model) => withCompatRoute(model, compat)),
      docsFailures: docsReport(run),
    }
  },
  async fetchSpec() {
    const { docs } = await load()
    const compat = await loadCompat()
    return {
      ...routeOnlyChatSpec([compat.route], {
        url: DASHSCOPE_CN_COMPAT,
        hash: compat.hash,
      }),
      sources: [
        ...docs.map(({ url, hash }) => ({ url, hash })),
        { url: DASHSCOPE_CN_COMPAT, hash: compat.hash },
      ],
    }
  },
  classify: classifyOpenCodeRoute,
}
