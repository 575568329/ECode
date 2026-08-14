import { describe, it, expect } from 'vitest'
import { resolveContextWindow, lookupContext, matchFallback, type ModelsDb } from '../../src/services/contextWindow.js'

// models.dev 实测样本（GLM 系列，context = 200×1024 = 204800；glm-5.2 = 1M）
const GLM_DB: ModelsDb = {
  zhipuai: {
    models: {
      'glm-4.6': { limit: { context: 204800 } },
      'glm-5': { limit: { context: 204800 } },
      'glm-5.2': { limit: { context: 1_000_000 } },
    },
  },
}

describe('lookupContext', () => {
  it('精确匹配', () => {
    expect(lookupContext(GLM_DB, 'glm-4.6')).toBe(204800)
  })

  it('provider/model 格式', () => {
    expect(lookupContext(GLM_DB, 'zhipuai/glm-4.6')).toBe(204800)
  })

  it('大小写不敏感', () => {
    expect(lookupContext(GLM_DB, 'GLM-4.6')).toBe(204800)
  })

  it('变体 startsWith（glm-4.6-air → glm-4.6）', () => {
    expect(lookupContext(GLM_DB, 'glm-4.6-air')).toBe(204800)
  })

  it('longest-id-first（glm-5.2 精确优先于 glm-5）', () => {
    // 'glm-5.2' 精确匹配 glm-5.2(1M)，不会被 glm-5(204800) 抢匹配
    expect(lookupContext(GLM_DB, 'glm-5.2')).toBe(1_000_000)
  })

  it('未命中 → undefined', () => {
    expect(lookupContext(GLM_DB, 'gpt-4o')).toBeUndefined()
  })

  it('限定 provider 前缀（避免跨 provider 误匹配）', () => {
    const db: ModelsDb = {
      zhipuai: { models: { 'glm-4.6': { limit: { context: 204800 } } } },
      other: { models: { 'glm-4.6': { limit: { context: 999999 } } } },
    }
    // 'zhipuai/glm-4.6' 限定 zhipuai，不命中 other 的同名
    expect(lookupContext(db, 'zhipuai/glm-4.6')).toBe(204800)
  })
})

describe('matchFallback（内置表）', () => {
  it('精确命中（GLM-4.6 = 204800，非 200000）', () => {
    expect(matchFallback('glm-4.6')).toBe(204800)
    expect(matchFallback('glm-5')).toBe(204800)
  })

  it('glm-5.2 = 1M', () => {
    expect(matchFallback('glm-5.2')).toBe(1_000_000)
  })

  it('变体（glm-4.6-flash → glm-4.6）', () => {
    expect(matchFallback('glm-4.6-flash')).toBe(204800)
  })

  it('未命中 → undefined', () => {
    expect(matchFallback('unknown-model')).toBeUndefined()
  })
})

describe('resolveContextWindow（四级 fallback）', () => {
  it('config 覆盖最高优先级', async () => {
    const r = await resolveContextWindow('glm-4.6', 50_000, () => Promise.resolve(GLM_DB))
    expect(r).toBe(50_000)
  })

  it('models.dev 命中', async () => {
    const r = await resolveContextWindow('glm-4.6', undefined, () => Promise.resolve(GLM_DB))
    expect(r).toBe(204800)
  })

  it('models.dev 拉失败（db=null）→ 内置表', async () => {
    const r = await resolveContextWindow('glm-4.6', undefined, () => Promise.resolve(null))
    expect(r).toBe(204800)
  })

  it('内置表也未命中 → 安全默认 32000 + 告警', async () => {
    const stderr: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const r = await resolveContextWindow('totally-unknown', undefined, () => Promise.resolve(null))
      expect(r).toBe(32_000)
      expect(stderr.join('')).toContain('未知模型')
    } finally {
      process.stderr.write = orig
    }
  })

  it('db 有更新值时优先于内置表', async () => {
    const db: ModelsDb = { x: { models: { 'glm-4.6': { limit: { context: 999_999 } } } } }
    const r = await resolveContextWindow('glm-4.6', undefined, () => Promise.resolve(db))
    expect(r).toBe(999_999)
  })

  it('dbLoader 未传（默认联网）时不抛——本测只验证签名兼容', async () => {
    // 默认 dbLoader 会真联网；这里用 config 覆盖短路，不触发联网
    const r = await resolveContextWindow('glm-4.6', 123_456)
    expect(r).toBe(123_456)
  })
})
