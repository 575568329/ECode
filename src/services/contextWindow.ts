/**
 * context window 解析（M5 §5）：四级 fallback，远程库为主（自动跟进新模型），config 覆盖为 escape hatch。
 *
 * 不能硬编码：模型 context window 各异且更新频繁（扩窗、新模型），API /models 也不暴露。
 * 四级优先级：config 覆盖 > models.dev（5min 缓存 + 离线兜底）> 内置最小表 > 安全默认 32k + 告警。
 *
 * models.dev schema（权威，同 opencode）：data[providerId].models[modelId].limit.context
 *   — 顶层是 map（key=providerId，如 "zhipuai"），model id 是裸名（如 "glm-4.6"）。
 *   — GLM 实测值：glm-4.6/glm-5 = 204800（= 200×1024，非 200000），glm-5.2 = 1000000。
 */

import { promises as fs } from 'node:fs'
import { syncPricingFromModelsDb } from './pricing.js'
import path from 'node:path'
import os from 'node:os'

const MODELS_URL = 'https://models.opencode.ai/api.json'
const CACHE_PATH = path.join(os.homedir(), '.ecode', 'cache', 'models.json')
const CACHE_TTL_MS = 5 * 60 * 1000
/** 拉取超时 3s：本调用在 loop 每轮 onBeforeRequest 热路径上（2026-09-02 真机实证
 *  models.dev 时通时断，10s 超时让会话连续 3 轮每轮白等 10s——宁可降级也不拖迭代）。 */
const FETCH_TIMEOUT_MS = 3_000
/** 拉取负缓存：失败/刚试过 → 60s 内不再发网络请求（防每轮重付超时） */
const FETCH_BACKOFF_MS = 60 * 1000
const SAFE_DEFAULT = 32_000

/** 内置兜底表（离线/拉取失败用）。值取自 models.dev 实测（GLM-4.6/5 = 204800 = 200×1024）。 */
const FALLBACK_TABLE: Record<string, number> = {
  'glm-5.2': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5': 204_800,
  'glm-4.7': 204_800,
  'glm-4.6': 204_800,
  'glm-4.5': 131_072,
  'glm-4': 131_072,
}

/** models.dev 数据形状（宽松解析：只取需要的 limit.context）。 */
export interface ModelsDb {
  [providerId: string]: {
    models?: Record<string, {
      limit?: { context?: number }
      /** 定价（$/Mtok；M8 债 #6 同步进 pricing 动态层） */
      cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
    }>
  }
}

/** 构建期快照（esbuild define 注入，离线兜底）；未注入时为 undefined，走内置表。 */
declare const ECODE_MODELS_SNAPSHOT: ModelsDb | undefined

let memoryCache: { db: ModelsDb; ts: number } | null = null
/** 上次拉取尝试时刻（成功失败都记，负缓存判定）；inflightRefresh 后台刷新去重 */
let lastFetchAttempt = 0
let inflightRefresh: Promise<void> | null = null

/**
 * 解析模型的 context window（四级 fallback）。
 * @param model 模型名（裸名 'glm-4.6' 或 'provider/model'）
 * @param configOverride config 的 contextWindow 覆盖（最高优先级）
 * @param dbLoader models.db 加载器（默认联网+缓存；测试可注入 mock）
 */
export async function resolveContextWindow(
  model: string,
  configOverride?: number,
  dbLoader: () => Promise<ModelsDb | null> = loadModelsDb,
): Promise<number> {
  // 1. config 覆盖（用户显式配置，最高优先级）
  if (configOverride && configOverride > 0) return configOverride
  // 2. models.dev 远程库
  const db = await dbLoader()
  if (db) {
    const ctx = lookupContext(db, model)
    if (ctx) return ctx
  }
  // 3. 内置兜底表
  const fb = matchFallback(model)
  if (fb) return fb
  // 4. 安全默认 + 告警（stderr 不污染 stdout/TUI）
  process.stderr.write(`[CONTEXT] 未知模型 ${model}，用安全默认 ${SAFE_DEFAULT}。可在 config 配 contextWindow 覆盖。\n`)
  return SAFE_DEFAULT
}

/**
 * 从 models.db 匹配 model 的 context（纯函数）。
 * 精确匹配优先，其次变体 startsWith（glm-4.6-air → glm-4.6）。支持 'provider/model' 和裸名。
 */
export function lookupContext(db: ModelsDb, model: string): number | undefined {
  const target = model.toLowerCase()
  const slashIdx = target.indexOf('/')
  const provFilter = slashIdx > 0 ? target.slice(0, slashIdx) : undefined
  const modelPart = slashIdx > 0 ? target.slice(slashIdx + 1) : target

  // 收集所有 (id, context) 候选（可跨 provider，或限定 provider）
  const candidates: { id: string; context: number }[] = []
  for (const [pid, provider] of Object.entries(db)) {
    if (provFilter && !pid.includes(provFilter)) continue
    for (const [mid, m] of Object.entries(provider.models ?? {})) {
      const ctx = m.limit?.context
      if (typeof ctx === 'number' && ctx > 0) candidates.push({ id: mid.toLowerCase(), context: ctx })
    }
  }
  // longest-id-first：长 id 优先（glm-4.6 优先于 glm-4，避免短 id 抢匹配）
  candidates.sort((a, b) => b.id.length - a.id.length)

  const exact = candidates.find((c) => c.id === modelPart)
  if (exact) return exact.context
  // 变体：model = key + '-...' 或 key = model + '-...'（双向容忍后缀差异）
  const variant = candidates.find((c) => modelPart.startsWith(c.id + '-') || c.id.startsWith(modelPart + '-'))
  return variant?.context
}

/** 内置表匹配（longest-key-first + 变体 startsWith）。 */
export function matchFallback(model: string): number | undefined {
  const key = (model.toLowerCase().split('/').pop() ?? model.toLowerCase())
  const sorted = Object.keys(FALLBACK_TABLE).sort((a, b) => b.length - a.length)
  for (const k of sorted) {
    if (key === k || key.startsWith(k + '-') || k.startsWith(key + '-')) return FALLBACK_TABLE[k]
  }
  return undefined
}

/**
 * 加载 models.db：内存缓存 → 磁盘缓存 → 联网拉取。全失败返回 null（走内置表）。
 *
 * 2026-09-02 热路径整改（真机实证：models.dev 拉取超时让会话连续 3 轮每轮卡 10s）：
 * - stale-while-revalidate——有过期旧值（内存/磁盘）立即先行返回，新鲜度后台刷新追进，
 *   loop 每轮 onBeforeRequest 永不为窗口解析付网络等待；
 * - 拉取负缓存（FETCH_BACKOFF_MS）——失败后 60s 内不再重试，防每轮重付超时；
 * - 仅进程内首次无任何缓存时同步拉取一次（上限 FETCH_TIMEOUT_MS）。
 */
export async function loadModelsDb(
  fetcher: () => Promise<ModelsDb | null> = fetchModelsDb,
  diskPath: string = CACHE_PATH,
): Promise<ModelsDb | null> {
  // 内存新鲜 → 直接返回（热路径第一站，零 IO）
  if (memoryCache !== null && Date.now() - memoryCache.ts < CACHE_TTL_MS) return memoryCache.db

  // 内存无值（进程首调用）才碰磁盘；过期旧值驻内存（后续轮次零磁盘读零解析）
  if (memoryCache === null) {
    const disk = await readDiskCache(diskPath)
    if (disk !== null && Date.now() - disk.ts < CACHE_TTL_MS) {
      memoryCache = disk
      syncPricingFromModelsDb(disk.db) // M8 债 #6：磁盘缓存命中同样同步（主路径——二次启动必走此分支）
      return disk.db
    }
    if (disk !== null) memoryCache = disk
  }

  // 有旧值（哪怕过期）→ 先行返回，后台刷新新鲜度
  if (memoryCache !== null) {
    refreshInBackground(fetcher, diskPath)
    return memoryCache.db
  }

  // 进程内首次且无任何缓存：同步拉取一次；失败进负缓存 60s
  if (fetchAllowed()) {
    lastFetchAttempt = Date.now()
    const fresh = await fetcher()
    if (fresh) {
      await applyFreshDb(fresh, diskPath)
      return fresh
    }
  }
  // 构建期快照（离线 + 首次无缓存）
  if (typeof ECODE_MODELS_SNAPSHOT !== 'undefined') return ECODE_MODELS_SNAPSHOT
  return null
}

/** 新库三件套：驻内存 + 落盘 + 同步定价（同步拉取与后台刷新共用）。 */
async function applyFreshDb(db: ModelsDb, diskPath: string): Promise<void> {
  memoryCache = { db, ts: Date.now() }
  await writeDiskCache(db, diskPath)
  syncPricingFromModelsDb(db) // M8 债 #6：cost 字段同步进定价动态层
}

/** 拉取防抖：距上次尝试不足 backoff → 不发请求（成功后内存缓存新鲜，天然不会走到这）。 */
function fetchAllowed(): boolean {
  return Date.now() - lastFetchAttempt >= FETCH_BACKOFF_MS
}

/** 后台刷新（revalidate 半边）：去重 + 负缓存门控，失败静默（下次过期再试）。 */
function refreshInBackground(fetcher: () => Promise<ModelsDb | null>, diskPath: string): void {
  if (inflightRefresh !== null || !fetchAllowed()) return
  lastFetchAttempt = Date.now()
  inflightRefresh = fetcher()
    .then(async (fresh) => {
      if (fresh !== null) await applyFreshDb(fresh, diskPath)
    })
    .catch(() => {})
    .finally(() => {
      inflightRefresh = null
    })
}

/** 测试用：重置内存缓存（避免跨用例污染）。 */
export function _resetCacheForTest(): void {
  memoryCache = null
  lastFetchAttempt = 0
  inflightRefresh = null
}

async function readDiskCache(diskPath: string = CACHE_PATH): Promise<{ db: ModelsDb; ts: number } | null> {
  const stat = await fs.stat(diskPath).catch(() => null)
  if (!stat) return null
  const text = await fs.readFile(diskPath, 'utf8').catch(() => null)
  if (!text) return null
  try {
    return { db: JSON.parse(text) as ModelsDb, ts: stat.mtimeMs }
  } catch {
    return null
  }
}

async function writeDiskCache(db: ModelsDb, diskPath: string = CACHE_PATH): Promise<void> {
  await fs.mkdir(path.dirname(diskPath), { recursive: true }).catch(() => {})
  const tempfile = diskPath + '.tmp'
  await fs.writeFile(tempfile, JSON.stringify(db), 'utf8').catch(() => {})
  await fs.rename(tempfile, diskPath).catch(() => {}) // 原子写（防半截）
}

async function fetchModelsDb(): Promise<ModelsDb | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(MODELS_URL, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as ModelsDb
  } catch {
    return null // 网络不可达/超时/解析失败 → 静默降级（走内置表）
  } finally {
    clearTimeout(timer)
  }
}
