/**
 * 成本核算：本地 model→价格表 + tokensToCost（cache 四维拆分）。
 *
 * M5 §4.4。单位 **人民币 ¥/Mtok**（ECode 首要跑 GLM/智谱，人民币计价，
 * 直接用官方价避免汇率转换失真）。
 *
 * ★ cache 必须拆：cache_read 单价只有 input 的 ~1/10。不拆、全按 input 算，
 * 成本高估 ~10×。cache 维度缺省：cacheRead = input × 0.1，cacheWrite = input × 1.25（行业惯例）。
 *
 * 未命中模型返回 null（UI 标「成本未知」），不瞎算（对标 claude-code hasUnknownModelCost）。
 * 价格变动频繁，表为 MVP 近似，后续从 models.dev 同步。
 */

/** 单模型定价（¥/Mtok）。cache 维度可选，缺省按 input 比例推算。 */
export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** cache 维度缺省推算比例（行业惯例）。 */
const CACHE_READ_RATIO = 0.1 // cache_read ≈ input 的 1/10
const CACHE_WRITE_RATIO = 1.25 // cache_write ≈ input 的 1.25×

/**
 * 本地定价表（¥/Mtok）。来源：bigmodel.cn/pricing（2025-2026 近似，以官方为准）。
 * 仅放确认过的模型；新模型（如 glm-5.2）未命中 → null（成本未知）。
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  'glm-4.5': { input: 0.8, output: 2 },
  'glm-4.6': { input: 5, output: 5 },
  'glm-4-plus': { input: 5, output: 5 },
  'glm-5': { input: 4, output: 18 },
  'glm-5.1': { input: 6, output: 24 },
  'glm-5.2': { input: 6, output: 24 }, // MVP 近似（同 5.1），待 models.dev 同步准确值
}

/** 动态层（M8 债 #6）：models.dev 刷新 cache 时同步的 cost（$→¥ 换算近似）。
 *  优先级：config 覆盖 > 动态层（models.dev 真值，覆盖本地近似）> 本地表（人工确认）。 */
const syncedPricing = new Map<string, ModelPricing>()
const USD_TO_CNY = 7.2 // 近似汇率（动态层是换算值；本地表人民币价为人工确认）

/** 从 models.db 同步 cost 进动态层（contextWindow 刷新 cache 后调用；空 cost 跳过）。 */
export function syncPricingFromModelsDb(db: {
  [providerId: string]: { models?: Record<string, { cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number } }> }
}): void {
  syncedPricing.clear()
  for (const provider of Object.values(db)) {
    for (const [modelId, m] of Object.entries(provider.models ?? {})) {
      const c = m.cost
      if (c === undefined || typeof c.input !== 'number' || typeof c.output !== 'number') continue
      const p: ModelPricing = { input: c.input * USD_TO_CNY, output: c.output * USD_TO_CNY }
      if (typeof c.cache_read === 'number') p.cacheRead = c.cache_read * USD_TO_CNY
      if (typeof c.cache_write === 'number') p.cacheWrite = c.cache_write * USD_TO_CNY
      syncedPricing.set(modelId.toLowerCase(), p)
    }
  }
}

/** 测试隔离：清空动态层。 */
export function _resetSyncedPricingForTest(): void {
  syncedPricing.clear()
}

function matchIn(table: Record<string, ModelPricing> | Map<string, ModelPricing>, model: string): ModelPricing | null {
  const key = model.toLowerCase()
  const exact = table instanceof Map ? table.get(key) : table[key]
  if (exact !== undefined) return exact
  // 变体匹配：model = key + '-' + 后缀（glm-4.6-air → glm-4.6）；longest-key-first 防短 id 抢匹配
  const keys = table instanceof Map ? [...table.keys()] : Object.keys(table)
  const sorted = keys.sort((a, b) => b.length - a.length)
  for (const k of sorted) {
    if (key.startsWith(k + '-')) return table instanceof Map ? (table.get(k) as ModelPricing) : table[k]
  }
  return null
}

/** 查模型定价：configOverride（providers.<name>.pricing）> 动态层 > 本地表。未命中 null。 */
export function lookupPricing(model: string, configOverride?: Record<string, ModelPricing>): ModelPricing | null {
  if (configOverride !== undefined) {
    const hit = matchIn(configOverride, model)
    if (hit !== null) return hit
  }
  const synced = matchIn(syncedPricing, model)
  if (synced !== null) return synced
  return matchIn(PRICING_TABLE, model)
}

/**
 * token 用量 → 成本（人民币元，cache 四维拆分）。未命中模型返回 null。
 *
 * cost = input/1e6 × inputPrice
 *      + output/1e6 × outputPrice
 *      + cacheRead/1e6 × cacheReadPrice      // 通常 = 0.1 × inputPrice
 *      + cacheCreation/1e6 × cacheWritePrice // 通常 = 1.25 × inputPrice
 */
export function tokensToCost(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number },
  configOverride?: Record<string, ModelPricing>,
): number | null {
  const p = lookupPricing(model, configOverride)
  if (!p) return null
  const cacheReadPrice = p.cacheRead ?? p.input * CACHE_READ_RATIO
  const cacheWritePrice = p.cacheWrite ?? p.input * CACHE_WRITE_RATIO
  return (
    (usage.input / 1e6) * p.input +
    (usage.output / 1e6) * p.output +
    (usage.cacheRead / 1e6) * cacheReadPrice +
    (usage.cacheCreation / 1e6) * cacheWritePrice
  )
}
