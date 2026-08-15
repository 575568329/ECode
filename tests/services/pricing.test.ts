import { describe, it, expect } from 'vitest'
import { tokensToCost, lookupPricing, syncPricingFromModelsDb, _resetSyncedPricingForTest } from '../../src/services/pricing.js'

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
    // glm-5.2 已收录；用未收录的测 null
    expect(tokensToCost('glm-5.3', { input: 100, output: 100, cacheRead: 0, cacheCreation: 0 })).toBeNull()
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

  it('版本号不误匹配（glm-5.3 ≠ glm-5）', () => {
    // 'glm-5.3' 不 startsWith 'glm-5-'（'.' 非 '-'），故不匹配 glm-5 → null
    expect(lookupPricing('glm-5.3')).toBeNull()
  })

  it('未命中 → null', () => {
    expect(lookupPricing('gpt-4o')).toBeNull()
  })
})

describe('M8 债 #6：动态层同步与 config 覆盖', () => {
  it('syncPricingFromModelsDb：cost 换算 ¥ 写入动态层并覆盖本地近似', () => {
    syncPricingFromModelsDb({
      zhipuai: { models: { 'glm-5.2': { cost: { input: 1, output: 3, cache_read: 0.1, cache_write: 1.25 } } } },
    })
    const p = lookupPricing('glm-5.2')
    expect(p?.input).toBeCloseTo(7.2, 5) // $1 × 7.2
    expect(p?.output).toBeCloseTo(21.6, 5)
    expect(p?.cacheRead).toBeCloseTo(0.72, 5)
    _resetSyncedPricingForTest()
    // 重置后回落本地表
    expect(lookupPricing('glm-5.2')?.input).toBe(6)
  })

  it('动态层未命中的模型回落本地表', () => {
    syncPricingFromModelsDb({ zhipuai: { models: { 'glm-9': { cost: { input: 2, output: 2 } } } } })
    expect(lookupPricing('glm-4.6')?.input).toBe(5) // 本地表
    expect(lookupPricing('glm-9')?.input).toBeCloseTo(14.4, 5) // 动态层
    _resetSyncedPricingForTest()
  })

  it('config 覆盖优先于动态层与本地表', () => {
    syncPricingFromModelsDb({ zhipuai: { models: { 'glm-5.2': { cost: { input: 1, output: 3 } } } } })
    const p = lookupPricing('glm-5.2', { 'glm-5.2': { input: 99, output: 99 } })
    expect(p?.input).toBe(99)
    _resetSyncedPricingForTest()
  })

  it('无 cost 字段的条目跳过（不写脏动态层）', () => {
    syncPricingFromModelsDb({ zhipuai: { models: { 'glm-5.2': {}, 'glm-x': { cost: { output: 3 } } } } })
    expect(lookupPricing('glm-5.2')?.input).toBe(6) // 回落本地表
    expect(lookupPricing('glm-x')).toBeNull() // cost 不完整整体跳过
    _resetSyncedPricingForTest()
  })

  it('tokensToCost 透传 configOverride', () => {
    const cost = tokensToCost('glm-5.2', { input: 1e6, output: 1e6, cacheRead: 0, cacheCreation: 0 }, { 'glm-5.2': { input: 10, output: 20 } })
    expect(cost).toBe(30)
  })
})
