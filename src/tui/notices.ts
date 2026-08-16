/**
 * 告警中心（M8 补充交付②）：运行时提示统一处理——队列聚合 + 三级分类 +
 * 底部单行派生（最高级最新一条 + 余量计数角标）。
 *
 * 分级：error（严重/红）> warn（警告/黄）> info（提示/信息蓝）——底部行优先展示
 * 更高级；同级取最新。/warnings 面板看全部。同文本去重（重复告警不刷屏），
 * 队列封顶 50（超限丢最旧 info→warn 优先保留高级）。
 */

export type NoticeLevel = 'error' | 'warn' | 'info'

export interface NoticeItem {
  id: number
  level: NoticeLevel
  text: string
}

export const NOTICE_LIMIT = 50

const LEVEL_WEIGHT: Record<NoticeLevel, number> = { error: 3, warn: 2, info: 1 }

/** 追加一条（同 level+text 去重；封顶淘汰：优先丢 info，同级丢最旧）。 */
export function pushNotice(list: NoticeItem[], id: number, level: NoticeLevel, text: string): NoticeItem[] {
  if (list.some((n) => n.level === level && n.text === text)) return list
  const next = [...list, { id, level, text }]
  if (next.length <= NOTICE_LIMIT) return next
  // 淘汰优先级：info 最先，同级最旧
  const dropIdx = next.findIndex((n) => n.level === 'info')
  const idx = dropIdx >= 0 ? dropIdx : next.findIndex((n) => n.level === 'warn')
  if (idx >= 0) return next.filter((_, i) => i !== idx)
  return next.slice(1)
}

/** 底部行派生：最高级最新一条 + 余量计数（“还有 N 条（/warnings 查看）”）。 */
export function deriveNoticeLine(list: NoticeItem[]): { level: NoticeLevel; text: string; rest: number } | null {
  if (list.length === 0) return null
  const topWeight = Math.max(...list.map((n) => LEVEL_WEIGHT[n.level]))
  const top = [...list].reverse().find((n) => LEVEL_WEIGHT[n.level] === topWeight)
  if (top === undefined) return null
  return { level: top.level, text: top.text, rest: list.length - 1 }
}

/** 面板分组顺序（严重 → 警告 → 提示）。 */
export function groupNotices(list: NoticeItem[]): Array<{ level: NoticeLevel; items: NoticeItem[] }> {
  const levels: NoticeLevel[] = ['error', 'warn', 'info']
  return levels
    .map((level) => ({ level, items: list.filter((n) => n.level === level) }))
    .filter((g) => g.items.length > 0)
}
