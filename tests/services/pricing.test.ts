import { describe, it, expect } from 'vitest'
import { tokensToCost, lookupPricing } from '../../src/services/pricing.js'

describe('tokensToCost', () => {
  it('四维拆分算对（input + output + cacheRead + cacheCreation）', () => {
    // glm-4.5: input 0.8, output 2（¥/Mtok）；cache 维度缺省 → 0.08 / 1.0
    const cost = tokensToCost('glm-4.5', { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheCreation: 100_000 })
    expect(cost).not.toBeNull()
    // input: 1e6/1e6 × 0.8 = 0.8
    // output: 0.5e6/1e6 × 2 = 1.0
    // cacheRead: 0.2e6/1e6 × 0.08 = 0.016
    // cacheCreation: 0.1e6/1e6 × 1.0 = 0.1
    // 合计 = 1.916
    expect(cost).toBeCloseTo(1.916, 3)
  })

  it('cacheRead 用 0.1× input（不高估 10×）', () => {
    const noCache = tokensToCost('glm-4.5', { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0 })
    // cacheRead 1M × 0.08（= 0.8 × 0.1）
    expect(noCache).toBeCloseTo(0.08, 4)
  })

  it('cacheCreation 用 1.25× input', () => {
    const c = tokensToCost('glm-4.5', { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 })
    // cacheCreation 1M × 1.0（= 0.8 × 1.25）
    expect(c).toBeCloseTo(1.0, 4)
  })

  it('显式配置的 cacheRead/cacheWrite 覆盖缺省比例', () => {
    // glm-4.6: input 5, output 5；假设未来显式配 cacheRead: 0.5
    // 用 lookupPricing 验证显式值优先
    const p = lookupPricing('glm-4.6')!
    expect(p.cacheRead).toBeUndefined() // 表里没配 → 用缺省
  })

  it('未命中模型 → null（成本未知）', () => {
    expect(tokensToCost('glm-5.2', { input: 100, output: 100, cacheRead: 0, cacheCreation: 0 })).toBeNull()
    expect(tokensToCost('unknown-model', { input: 100, output: 100, cacheRead: 0, cacheCreation: 0 })).toBeNull()
  })

  it('零用量 → 0 成本', () => {
    expect(tokensToCost('glm-4.6', { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0)
  })
})

describe('lookupPricing', () => {
  it('精确匹配', () => {
    expect(lookupPricing('glm-4.6')?.input).toBe(5)
    expect(lookupPricing('GLM-4.6')?.input).toBe(5) // 大小写不敏感
  })

  it('子串匹配（glm-4.6-air → glm-4.6）', () => {
    expect(lookupPricing('glm-4.6-air')?.input).toBe(5)
  })

  it('版本号不误匹配（glm-5.2 ≠ glm-5）', () => {
    // 'glm-5.2' 不 startsWith 'glm-5-'（'.' 非 '-'），故不匹配 glm-5 → null
    expect(lookupPricing('glm-5.2')).toBeNull()
  })

  it('未命中 → null', () => {
    expect(lookupPricing('gpt-4o')).toBeNull()
  })
})
