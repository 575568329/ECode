import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resolveContextWindow,
  lookupContext,
  matchFallback,
  loadModelsDb,
  _resetCacheForTest,
  type ModelsDb,
} from '../../src/services/contextWindow.js'

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

describe('loadModelsDb 热路径（2026-09-02 整改：stale-while-revalidate + 负缓存）', () => {
  let tmpRoot: string
  let diskPath: string

  beforeEach(async () => {
    _resetCacheForTest()
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ecode-cw-'))
    diskPath = path.join(tmpRoot, 'models.json')
  })

  afterEach(async () => {
    _resetCacheForTest()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  /** 写磁盘缓存并回拨 mtime 模拟过期（readDiskCache 以 mtime 为 ts） */
  async function seedDisk(db: ModelsDb, ageMs: number): Promise<void> {
    await writeFile(diskPath, JSON.stringify(db), 'utf8')
    const t = new Date(Date.now() - ageMs)
    await utimes(diskPath, t, t)
  }

  /** 等后台刷新链（loader 微任务 + 磁盘写）落地 */
  const settle = async (ms = 30): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms))
  }

  it('磁盘过期 + 联网成功 → 先行返回旧值不等网络，后台刷新后取到新值', async () => {
    await seedDisk(GLM_DB, 10 * 60 * 1000)
    const FRESH: ModelsDb = { zhipuai: { models: { 'glm-9': { limit: { context: 123 } } } } }
    let n = 0
    const fetcher = async (): Promise<ModelsDb | null> => {
      n++
      return FRESH
    }
    const first = await loadModelsDb(fetcher, diskPath)
    expect(lookupContext(first as ModelsDb, 'glm-4.6')).toBe(204800) // 先行旧值
    await settle()
    const reread = await loadModelsDb(fetcher, diskPath)
    expect(lookupContext(reread as ModelsDb, 'glm-9')).toBe(123) // 后台刷新已生效
    expect(n).toBe(1)
  })

  it('磁盘过期 + 联网失败 → 立即返回旧值，负缓存 60s 内不重试', async () => {
    await seedDisk(GLM_DB, 10 * 60 * 1000)
    // 慢失败 fetcher：若实现退化成同步等网络，首调用会拖满 300ms
    let n = 0
    const slowFail = async (): Promise<ModelsDb | null> => {
      n++
      await new Promise((r) => setTimeout(r, 300))
      return null
    }
    const t0 = Date.now()
    const first = await loadModelsDb(slowFail, diskPath)
    expect(Date.now() - t0).toBeLessThan(250) // 先行返回，不为网络等
    expect(lookupContext(first as ModelsDb, 'glm-4.6')).toBe(204800)
    await settle(400) // 后台那次失败落定
    for (let i = 0; i < 2; i++) {
      const db = await loadModelsDb(slowFail, diskPath)
      expect(lookupContext(db as ModelsDb, 'glm-4.6')).toBe(204800)
    }
    expect(n).toBe(1) // 负缓存拦掉后续重试（旧行为：每轮重付超时）
  })

  it('无任何缓存 + 联网失败 → null（走内置表），负缓存内第二次不再发请求', async () => {
    let n = 0
    const fail = async (): Promise<ModelsDb | null> => {
      n++
      return null
    }
    expect(await loadModelsDb(fail, diskPath)).toBeNull()
    expect(await loadModelsDb(fail, diskPath)).toBeNull()
    expect(n).toBe(1)
  })

  it('无缓存 + 联网成功 → 返回新值并落盘', async () => {
    const db = await loadModelsDb(async () => GLM_DB, diskPath)
    expect(lookupContext(db as ModelsDb, 'glm-4.6')).toBe(204800)
    await settle()
    expect(existsSync(diskPath)).toBe(true)
  })

  it('内存新鲜 → 不碰磁盘不联网（热路径零 IO）', async () => {
    await loadModelsDb(async () => GLM_DB, diskPath)
    await settle()
    let n = 0
    const db = await loadModelsDb(
      async () => {
        n++
        return null
      },
      path.join(tmpRoot, 'nope.json'),
    )
    expect(lookupContext(db as ModelsDb, 'glm-4.6')).toBe(204800)
    expect(n).toBe(0)
  })
})
