import { describe, it, expect } from 'vitest';
import { computeCost } from '../src/providers/cost.js';
import type { ECodeUsage, ModelCost } from '../src/providers/types.js';

describe('computeCost', () => {
  const cost: ModelCost = { input: 0.27, output: 1.1, cacheRead: 0.03, cacheWrite: 0.3 };

  it('纯输入输出按单价计算（无缓存）', () => {
    const usage: ECodeUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    // 1M * 0.27 + 0.5M * 1.1 = 0.27 + 0.55 = 0.82
    expect(computeCost(usage, cost)).toBeCloseTo(0.82, 6);
  });

  it('命中缓存的 input 按缓存价（非缓存部分按 input 全价，不重复计费）', () => {
    const usage: ECodeUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 };
    // 总输入 1M 含 400K cache → 非缓存 600K * 0.27 + 缓存 400K * 0.03 = 0.162 + 0.012 = 0.174
    expect(computeCost(usage, cost)).toBeCloseTo(0.174, 6);
  });

  it('cacheWrite 按 cacheWrite 价计费（与 cacheRead 独立）', () => {
    const usage: ECodeUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 200_000 };
    // 总输入 1M 含 200K cacheWrite → 非缓存 800K * 0.27 + 200K * 0.3 = 0.216 + 0.06 = 0.276
    expect(computeCost(usage, cost)).toBeCloseTo(0.276, 6);
  });

  it('output 含 reasoning 也按 output 单价（reasoning 不单算）', () => {
    const usage: ECodeUsage = { inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 800_000 };
    // 1M * 1.1 = 1.1
    expect(computeCost(usage, cost)).toBeCloseTo(1.1, 6);
  });

  it('缺省单价的档位按 0 计费（兼容旧 config 不配某档的模型）', () => {
    const usage: ECodeUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const partial: ModelCost = { input: 0.5 };
    // 1M * 0.5 + 0 = 0.5
    expect(computeCost(usage, partial)).toBeCloseTo(0.5, 6);
  });

  it('空 cost 对象全部按 0', () => {
    const usage: ECodeUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(computeCost(usage, {})).toBe(0);
  });

  it('cacheRead + cacheWrite 同时存在，非缓存不重复计费', () => {
    const usage: ECodeUsage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 100_000,
    };
    // 总输入 1M = 非缓存 600K + cacheRead 300K + cacheWrite 100K
    // 600K * 0.27 + 300K * 0.03 + 100K * 0.3 = 0.162 + 0.009 + 0.03 = 0.201
    expect(computeCost(usage, cost)).toBeCloseTo(0.201, 6);
  });
});
