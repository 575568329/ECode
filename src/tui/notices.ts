/**
 * 告警中心（M8 补充交付②，F-38 秩序化）：运行时提示统一处理——队列聚合 + 三级分类 +
 * 底部单行派生（最高级最新一条 + 余量计数角标）。
 *
 * 分级与驻留（F-38：ECode 自身提示统一只在最下一行，临时提示到期自动消失——
 * 「内容框只放内容」；错误分类有秩序：error 需要用户处理故常驻，warn/info 提示性质到期退场）：
 *   error 常驻（直到被更高优先级顶掉或 /clear）> warn 12s > info 5s。
 * /warnings 面板看全部历史（含已过期）。同文本去重（重复告警不刷屏），
 * 队列封顶 50（超限丢最旧 info→warn 优先保留高级）。
 */

import stringWidth from 'string-width'

export type NoticeLevel = 'error' | 'warn' | 'info'

/** 分级驻留时长（ms）——undefined=常驻。到期条目不再上底部行（面板仍可见）。 */
export const NOTICE_TTL_MS: Record<NoticeLevel, number | undefined> = {
  error: undefined,
  warn: 12_000,
  info: 5_000,
}

export interface NoticeItem {
  id: number
  level: NoticeLevel
  text: string
  /** 入队时刻（F-38 TTL 判定基准；测试可注入固定时钟） */
  at: number
  /** 2026-09-03 拍板（中断提示常驻「直到问题解决」）：sticky=true 的 error 不随轮成功
   *  自动清（如本地降级警示——续聊期间约束必须持续可见，仅用户 /warnings 清空） */
  sticky?: boolean
}

export const NOTICE_LIMIT = 50

const LEVEL_WEIGHT: Record<NoticeLevel, number> = { error: 3, warn: 2, info: 1 }

/** 追加一条（同 level+text 去重；封顶淘汰：优先丢 info，同级丢最旧）。 */
export function pushNotice(list: NoticeItem[], id: number, level: NoticeLevel, text: string, at = Date.now(), sticky = false): NoticeItem[] {
  if (list.some((n) => n.level === level && n.text === text)) return list
  const next = [...list, { id, level, text, at, ...(sticky ? { sticky: true } : {}) }]
  if (next.length <= NOTICE_LIMIT) return next
  // 淘汰优先级：info 最先，同级最旧（sticky error 不参与淘汰——先剔出淘汰序列）
  const pool = next.map((n, i) => ({ n, i })).filter((e) => e.n.sticky !== true)
  const dropIdx = pool.find((e) => e.n.level === 'info')?.i ?? pool.find((e) => e.n.level === 'warn')?.i ?? pool[0]?.i
  if (dropIdx !== undefined) return next.filter((_, i) => i !== dropIdx)
  return next.slice(1)
}

/** 条目是否仍在驻留期内（error 恒 fresh；TTL 判定基准 now 显式传入保纯函数可测）。 */
export function isFresh(item: NoticeItem, now: number): boolean {
  const ttl = NOTICE_TTL_MS[item.level]
  return ttl === undefined || now - item.at < ttl
}

/** 底部行派生：**驻留期内**最高级最新一条 + 余量计数（“还有 N 条（/warnings 查看）”）。
 *  过期条目不上行（F-38：临时提示一会儿就消失），余量计数也只数驻留期内——
 *  面板里的历史不算「还有」。 */
export function deriveNoticeLine(list: NoticeItem[], now = Date.now()): { level: NoticeLevel; text: string; rest: number } | null {
  const fresh = list.filter((n) => isFresh(n, now))
  if (fresh.length === 0) return null
  const topWeight = Math.max(...fresh.map((n) => LEVEL_WEIGHT[n.level]))
  const top = [...fresh].reverse().find((n) => LEVEL_WEIGHT[n.level] === topWeight)
  if (top === undefined) return null
  return { level: top.level, text: top.text, rest: fresh.length - 1 }
}

/** 面板分组顺序（严重 → 警告 → 提示）。 */
export function groupNotices(list: NoticeItem[]): Array<{ level: NoticeLevel; items: NoticeItem[] }> {
  const levels: NoticeLevel[] = ['error', 'warn', 'info']
  return levels
    .map((level) => ({ level, items: list.filter((n) => n.level === level) }))
    .filter((g) => g.items.length > 0)
}

const NOTICE_ICON: Record<NoticeLevel, string> = { error: '✖', warn: '⚠', info: 'ℹ' }

/**
 * 底部告警行渲染（M8 补充②终版）：**保证单行不换行**——
 * 图标 + 消息（宽度感知截断，string-width 计中文 2 列）+ 计数角标（**完整保留**，
 * 截断只吃消息本体——角标是用户看全部问题的入口，不能被挤掉）。
 * 详细内容不塞这行，用 /warnings 看。
 */
export function renderNoticeLine(line: { level: NoticeLevel; text: string; rest: number }, cols: number): string {
  const icon = NOTICE_ICON[line.level]
  const fullBadge = line.rest > 0 ? ` · 还有 ${line.rest} 条（/warnings 查看）` : ''
  // 窄终端降级（审阅 P1-2）：整角标放不下时缩为 (+N)，再放不下彻底去掉——
  // 单行不换行优先于角标完整；宽终端（≥~45 列）两档都不触发
  const budgetWith = (badge: string): number => cols - stringWidth(icon) - 2 - stringWidth(badge) - 1
  if (line.rest > 0 && budgetWith(fullBadge) >= 10) {
    return `${icon}  ${clampByWidth(line.text, budgetWith(fullBadge))}${fullBadge}`
  }
  const shortBadge = line.rest > 0 ? ` (+${line.rest})` : ''
  if (line.rest > 0 && budgetWith(shortBadge) >= 10) {
    return `${icon}  ${clampByWidth(line.text, budgetWith(shortBadge))}${shortBadge}`
  }
  return `${icon}  ${clampByWidth(line.text, Math.max(10, budgetWith('')))}`
}

/** 显示宽度截断（中文按 2 列计——js 字符数截断会超宽导致 Ink 换行）。 */
function clampByWidth(text: string, maxCols: number): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim()
  if (stringWidth(flat) <= maxCols) return flat
  let out = ''
  let w = 0
  for (const ch of flat) {
    const cw = stringWidth(ch)
    if (w + cw > maxCols - 1) return `${out}…`
    out += ch
    w += cw
  }
  return out
}
