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
}

/** 查模型定价。精确匹配优先，其次变体后缀匹配（glm-4.6-air → glm-4.6）。未命中返回 null。 */
export function lookupPricing(model: string): ModelPricing | null {
  const key = model.toLowerCase()
  if (PRICING_TABLE[key]) return PRICING_TABLE[key]
  // 变体匹配：model = key + '-' + 后缀（如 glm-4.6-air / glm-4.6-0520 → glm-4.6）。
  // 用 startsWith(key + '-') 而非 includes，避免版本号误匹配（glm-5.2 ≠ glm-5，因 'glm-5.2' 不 startsWith 'glm-5-'）。
  // longest-key-first：长 id 优先，避免短 id 抢匹配。
  const sorted = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length)
  for (const k of sorted) {
    if (key.startsWith(k + '-')) return PRICING_TABLE[k]
  }
  return null
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
): number | null {
  const p = lookupPricing(model)
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
