// ============================================================
// 费用计算（支点17 cost 精确化）—— 纯函数，usage + 单价 → $ 金额
// ============================================================
//
// 语义前提（transform 已统一）：inputTokens = 总输入（含 cache），cacheRead/cacheWrite
// 是其中的子集。故「非缓存输入 = inputTokens - cacheRead - cacheWrite」按 input 全价；
// cacheRead 按 cacheRead 价、cacheWrite 按 cacheWrite 价、output（含 reasoning）按 output 价。
// 缺省单价档位按 0（兼容旧 config 不配 cost 的模型）。
import type { ECodeUsage, ModelCost } from './types.js';

/**
 * 计算一次 LLM 调用的费用（美元）。
 *
 * @param usage token 用量（inputTokens 为总输入含 cache，由 transform 统一）
 * @param cost  模型单价（$/M token，各档可选，缺省按 0）
 * @returns 费用（$），无 cost 配置时返回 0
 */
export function computeCost(usage: ECodeUsage, cost: ModelCost): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // 非缓存输入 = 总输入 - 命中缓存 - 写入缓存（防御 cache 超过 total 的异常取 0）
  const nonCacheInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return (
    (nonCacheInput * (cost.input ?? 0) +
      cacheRead * (cost.cacheRead ?? 0) +
      cacheWrite * (cost.cacheWrite ?? 0) +
      usage.outputTokens * (cost.output ?? 0)) /
    1_000_000
  );
}
