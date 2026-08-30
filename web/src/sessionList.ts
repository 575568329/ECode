/**
 * 批 2 会话列表纯逻辑（可单测，不依赖 React/store）：
 * 时间分组（今日/昨日/过去 7 天/更早）+ 客户端搜索 + 归档拆分。
 */

export interface SidebarSession {
  sessionId: string
  /** 显示标题（renamed title 或 firstUser；''=用 sessionId 尾段） */
  title: string
  updatedAt: number
  running: boolean
  archived?: boolean
}

export interface SessionGroup {
  label: string
  items: SidebarSession[]
}

/** 自然日起点（本地时区） */
function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 按更新时间归入固定有序组：今日 / 昨日 / 过去 7 天 / 更早。空组不产出。 */
export function groupSessionsByTime(sessions: SidebarSession[], now: number = Date.now()): SessionGroup[] {
  const today = startOfDay(now)
  const dayMs = 24 * 60 * 60 * 1000
  const buckets: Array<{ label: string; items: SidebarSession[] }> = [
    { label: '今日', items: [] },
    { label: '昨日', items: [] },
    { label: '过去 7 天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const s of sessions) {
    const day = startOfDay(s.updatedAt)
    if (day === today) buckets[0].items.push(s)
    else if (day === today - dayMs) buckets[1].items.push(s)
    else if (s.updatedAt >= today - 7 * dayMs) buckets[2].items.push(s)
    else buckets[3].items.push(s)
  }
  return buckets.filter((b) => b.items.length > 0)
}

/** 客户端子串搜索（title + sessionId，大小写不敏感） */
export function searchSessions(sessions: SidebarSession[], q: string): SidebarSession[] {
  const needle = q.trim().toLowerCase()
  if (needle === '') return sessions
  return sessions.filter((s) => s.title.toLowerCase().includes(needle) || s.sessionId.toLowerCase().includes(needle))
}

/** 归档拆分：主列表（未归档）与归档桶 */
export function splitArchived(sessions: SidebarSession[]): { active: SidebarSession[]; archived: SidebarSession[] } {
  return {
    active: sessions.filter((s) => s.archived !== true),
    archived: sessions.filter((s) => s.archived === true),
  }
}

/** 显示标题：空标题回退 sessionId 尾段（与 SessionRow 现行为一致） */
export function displayTitle(s: SidebarSession): string {
  return s.title === '' ? s.sessionId.slice(-12) : s.title
}
