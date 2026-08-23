/**
 * M12-P0：跨会话用量统计（/stats）。
 *
 * 数据源是会话 JSONL 里的 stats 行（HostSession recordUsage 逐帧追加，自包含
 * cwd/model/ts——见 history.ts UsageStatsRecord）。本模块只做读侧聚合：
 * 按会话（文件）/按天/按模型/按项目四个维度 + 缓存命中率 + MCP 调用数。
 *
 * 缓存策略：**文件级 mtime 缓存**（~/.ecode/stats-cache.json）——会话文件 append-only，
 * mtime 不变则聚合结果不变，跳过重读；变更文件单独重算。比 CC 的按天缓存粒度更细且
 * 无跨天漂移问题（opencode 全量扫描式 stats 在大数据集上自曝慢，不效仿）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface StatsTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costCny: number
}

/** 单会话聚合（缓存的最小单元） */
export interface SessionAgg {
  sessionId: string
  firstTs: number
  lastTs: number
  cwd: string
  models: string[]
  /** 会话累计 MCP 调用数（取最后一条 stats 行的 mcpCalls——累计快照语义） */
  mcpCalls: number
  totals: StatsTotals
  /** 按天分布（ts→日期键；多行同天累加） */
  days: Record<string, StatsTotals>
  /** 按模型逐行累加（审阅 P0-1：多模型会话按行内 model 归账——会话级口径会重复计费） */
  byModel: Record<string, StatsTotals>
  /** 含未收录定价（costKnown=false）的行数——聚合侧提示"部分成本未知"（审阅 P1-5） */
  costUnknownLines: number
  firstUser?: string
}

export interface StatsAgg {
  totals: StatsTotals
  mcpCalls: number
  sessions: number
  /** 含未收录定价的会话数（成本为已知部分之和——展示须提示） */
  costUnknownSessions: number
  /** cacheRead / (input + cacheRead)——命中=输入侧走缓存的比例（cache 写入不算命中候选） */
  cacheHitRate: number
  byDay: Array<{ date: string; sessions: number } & StatsTotals & { mcpCalls: number }>
  byModel: Array<{ model: string } & StatsTotals>
  byProject: Array<{ project: string } & StatsTotals & { mcpCalls: number }>
  topSessions: SessionAgg[]
}

interface StatsCacheFile {
  /**
   * v2（2026-08-23）：SessionAgg 增 byModel/costCny/costUnknownLines（审阅修复批结构变更）。
   * v1 缓存结构不兼容（缺 byModel 会让聚合抛错）——整体弃用重建。
   * 结构防御（version 忘升的未来保险）：命中条目缺 byModel 字段视为 miss 重算。
   */
  version: 2
  /** agg: null = 负缓存（该文件无 stats 行且 mtime 未变——审阅 P1-6：旧会话文件不必每次重读） */
  files: Record<string, { mtimeMs: number; agg: SessionAgg | null }>
}

const EMPTY_TOTALS = (): StatsTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costCny: 0 })

const addTotals = (a: StatsTotals, b: StatsTotals): StatsTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  costCny: a.costCny + b.costCny,
})

/** ts(ms) → 本地日期键 YYYY-MM-DD（按本地时区分天——统计口径跟用户体感走） */
export function dateKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 解析单个会话文件（只认 stats 行与首行 meta；无 stats 行返回 null） */
export function parseSessionFile(filePath: string, sessionId: string): SessionAgg | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const agg: SessionAgg = {
    sessionId,
    firstTs: 0,
    lastTs: 0,
    cwd: '',
    models: [],
    mcpCalls: 0,
    totals: EMPTY_TOTALS(),
    days: {},
    byModel: {},
    costUnknownLines: 0,
  }
  let sawStats = false
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.meta === true) {
      const first = parsed.firstUser
      if (typeof first === 'string' && first !== '') agg.firstUser = first
      continue
    }
    if (parsed.stats !== true) continue
    sawStats = true
    const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now()
    // costCny 现行字段；costUsd 为批2 首日旧字段名（值同为人民币元——审阅 P0-2 勘误前误标 $）
    const costCnyRaw = typeof parsed.costCny === 'number' ? parsed.costCny : typeof parsed.costUsd === 'number' ? parsed.costUsd : 0
    const costKnown = parsed.costKnown !== false // 旧行无字段视为已知（首日数据均已知）
    if (!costKnown) agg.costUnknownLines++
    const lineTotals: StatsTotals = {
      input: typeof parsed.input === 'number' ? parsed.input : 0,
      output: typeof parsed.output === 'number' ? parsed.output : 0,
      cacheRead: typeof parsed.cacheRead === 'number' ? parsed.cacheRead : 0,
      cacheCreation: typeof parsed.cacheCreation === 'number' ? parsed.cacheCreation : 0,
      costCny: costCnyRaw,
    }
    const lineModel = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : '?'
    agg.byModel[lineModel] = addTotals(agg.byModel[lineModel] ?? EMPTY_TOTALS(), lineTotals)
    agg.firstTs = agg.firstTs === 0 ? ts : Math.min(agg.firstTs, ts)
    agg.lastTs = Math.max(agg.lastTs, ts)
    agg.totals = addTotals(agg.totals, lineTotals)
    const day = dateKey(ts)
    agg.days[day] = addTotals(agg.days[day] ?? EMPTY_TOTALS(), lineTotals)
    if (typeof parsed.cwd === 'string' && parsed.cwd !== '') {
      const cwd = parsed.cwd
      if (agg.cwd === '') agg.cwd = cwd
      else if (agg.cwd !== cwd) agg.cwd = agg.cwd // 会话内换项目（罕见）：保首个
    }
    if (!agg.models.includes(lineModel)) agg.models.push(lineModel)
    if (typeof parsed.mcpCalls === 'number') agg.mcpCalls = parsed.mcpCalls // 累计快照：最后一条生效
  }
  return sawStats ? agg : null
}

function loadCache(cachePath: string): StatsCacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as StatsCacheFile
    if (raw.version === 2 && typeof raw.files === 'object' && raw.files !== null) return raw
  } catch {
    // 无缓存/损坏 → 重建
  }
  return { version: 2, files: {} }
}

function saveCache(cachePath: string, cache: StatsCacheFile): void {
  try {
    const tmp = `${cachePath}.tmp`
    // mode 0o600：缓存含 firstUser（用户 prompt 原文）且落在 ~/.ecode（sessions 0700 之外）——审阅 P2-3
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 })
    fs.renameSync(tmp, cachePath)
  } catch {
    // 缓存写失败不影响统计（下次重算）
  }
}

/** 项目显示名：路径尾段（跨盘符/长路径友好） */
function projectLabel(cwd: string): string {
  if (cwd === '') return '（未知）'
  const segs = cwd.split(/[\\/]/).filter(Boolean)
  return segs[segs.length - 1] ?? cwd
}

/** 聚合入口：dir=会话目录；cachePath 缺省 ~/.ecode/stats-cache.json */
export function aggregateStats(dir: string, cachePath = path.join(os.homedir(), '.ecode', 'stats-cache.json')): StatsAgg {
  const cache = loadCache(cachePath)
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return {
      totals: EMPTY_TOTALS(),
      mcpCalls: 0,
      sessions: 0,
      costUnknownSessions: 0,
      cacheHitRate: 0,
      byDay: [],
      byModel: [],
      byProject: [],
      topSessions: [],
    }
  }
  const sessionAggs: SessionAgg[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const sessionId = f.slice(0, -'.jsonl'.length)
    seen.add(sessionId)
    const filePath = path.join(dir, f)
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs
    } catch {
      continue
    }
    const hit = cache.files[sessionId]
    if (hit !== undefined && hit.mtimeMs === mtimeMs && (hit.agg === null || typeof hit.agg.byModel === 'object')) {
      // 负缓存命中（agg:null，无 stats 行的旧会话）也跳过——审阅 P1-6；
      // 结构防御：agg 非 null 但缺 byModel（旧结构缓存）视为 miss 重算
      if (hit.agg !== null) sessionAggs.push(hit.agg)
      continue
    }
    const agg = parseSessionFile(filePath, sessionId)
    cache.files[sessionId] = { mtimeMs, agg } // null 也缓存（负缓存）
    if (agg !== null) sessionAggs.push(agg)
  }
  // 审阅 P2-1：会话文件已被删除的缓存残留清理
  for (const k of Object.keys(cache.files)) {
    if (!seen.has(k)) delete cache.files[k]
  }
  saveCache(cachePath, cache)

  const totals = sessionAggs.reduce((acc, s) => addTotals(acc, s.totals), EMPTY_TOTALS())
  const dayMap = new Map<string, { sessions: Set<string> } & StatsTotals & { mcpCalls: number }>()
  const modelMap = new Map<string, StatsTotals>()
  const projMap = new Map<string, StatsTotals & { mcpCalls: number }>()
  for (const s of sessionAggs) {
    for (const [day, t] of Object.entries(s.days)) {
      const cur = dayMap.get(day) ?? { sessions: new Set<string>(), ...EMPTY_TOTALS(), mcpCalls: 0 }
      cur.sessions.add(s.sessionId)
      dayMap.set(day, { ...addTotals(cur, t), sessions: cur.sessions, mcpCalls: cur.mcpCalls })
    }
    // 审阅 P0-1：按会话内逐行 byModel 合并（会话级口径对多模型会话重复计费）
    for (const [m, t] of Object.entries(s.byModel)) {
      modelMap.set(m, addTotals(modelMap.get(m) ?? EMPTY_TOTALS(), t))
    }
    const p = projectLabel(s.cwd)
    const pc = projMap.get(p) ?? { ...EMPTY_TOTALS(), mcpCalls: 0 }
    projMap.set(p, { ...addTotals(pc, s.totals), mcpCalls: pc.mcpCalls + s.mcpCalls })
  }
  const hitDenominator = totals.input + totals.cacheRead
  return {
    totals,
    mcpCalls: sessionAggs.reduce((n, s) => n + s.mcpCalls, 0),
    sessions: sessionAggs.length,
    costUnknownSessions: sessionAggs.filter((s) => s.costUnknownLines > 0).length,
    cacheHitRate: hitDenominator > 0 ? totals.cacheRead / hitDenominator : 0,
    byDay: [...dayMap.entries()]
      .map(([date, v]) => ({ date, sessions: v.sessions.size, ...stripTotals(v), mcpCalls: 0 }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    byModel: [...modelMap.entries()].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.costCny - a.costCny),
    byProject: [...projMap.entries()].map(([project, v]) => ({ project, ...stripTotals(v), mcpCalls: v.mcpCalls })).sort((a, b) => b.costCny - a.costCny),
    topSessions: [...sessionAggs].sort((a, b) => b.totals.costCny - a.totals.costCny).slice(0, 3),
  }
}

function stripTotals(v: StatsTotals): StatsTotals {
  return { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheCreation: v.cacheCreation, costCny: v.costCny }
}

// —— 格式化（/stats 输出；纯 ASCII 结构符，规避 ambiguous 宽度错位）——

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// 审阅 P0-2：pricing.ts 口径是人民币元（不换算防失真）——¥ 前缀
const fmtCost = (cny: number): string => `¥${cny < 0.01 && cny > 0 ? cny.toFixed(4) : cny.toFixed(3)}`

export function formatStats(agg: StatsAgg): string {
  const lines: string[] = []
  const t = agg.totals
  if (agg.sessions === 0) {
    return '用量统计：暂无数据（M12 起新会话产生用量后可查）'
  }
  lines.push(`用量统计 · ${agg.sessions} 个会话`)
  lines.push(
    `总计：输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)} · 缓存读 ${fmtTokens(t.cacheRead)}（命中 ${(agg.cacheHitRate * 100).toFixed(1)}%）· 缓存写 ${fmtTokens(t.cacheCreation)} · ${fmtCost(t.costCny)} · MCP ${agg.mcpCalls} 次`,
  )
  if (agg.costUnknownSessions > 0) {
    lines.push(`（${agg.costUnknownSessions} 个会话含未收录定价的模型，其成本未计入——可在 config providers 配 pricing）`)
  }
  if (agg.byDay.length > 0) {
    lines.push('最近 7 个有数据的天（新在前）：')
    for (const d of agg.byDay.slice(0, 7)) {
      lines.push(`  ${d.date}  输入 ${fmtTokens(d.input)} · 输出 ${fmtTokens(d.output)} · ${fmtCost(d.costCny)} · ${d.sessions} 会话`)
    }
  }
  if (agg.byModel.length > 0) {
    lines.push('按模型：')
    for (const m of agg.byModel.slice(0, 5)) {
      lines.push(`  ${m.model}  输入 ${fmtTokens(m.input)} · 输出 ${fmtTokens(m.output)} · ${fmtCost(m.costCny)}`)
    }
  }
  if (agg.byProject.length > 0) {
    lines.push('按项目（前 5）：')
    for (const p of agg.byProject.slice(0, 5)) {
      lines.push(`  ${p.project}  输入 ${fmtTokens(p.input)} · ${fmtCost(p.costCny)} · MCP ${p.mcpCalls} 次`)
    }
  }
  if (agg.topSessions.length > 0) {
    lines.push('最贵会话（前 3）：')
    for (const s of agg.topSessions) {
      const head = s.firstUser !== undefined ? `「${Array.from(s.firstUser).slice(0, 12).join('')}」` : ''
      lines.push(`  ${dateKey(s.lastTs).slice(5)} ${s.models.join('/') || '?'} ${fmtCost(s.totals.costCny)} ${head}`)
    }
  }
  return lines.join('\n')
}
