/** 批 2 会话列表纯逻辑单测：时间分组 / 搜索 / 归档拆分 / 显示标题回退 */
import { describe, expect, it } from 'vitest'
import { displayTitle, groupSessionsByTime, searchSessions, splitArchived, type SidebarSession } from '../src/sessionList'

const now = new Date('2026-08-30T15:00:00').getTime()
const day = 24 * 60 * 60 * 1000

function s(id: string, updatedAt: number, title = `会话${id}`, archived?: boolean): SidebarSession {
  return { sessionId: id, title, updatedAt, running: false, ...(archived !== undefined ? { archived } : {}) }
}

describe('groupSessionsByTime', () => {
  it('归入今日/昨日/过去 7 天/更早 四组，空组不产出，组内按传入顺序', () => {
    const groups = groupSessionsByTime(
      [s('today', now - 1000), s('yesterday', now - day - 1000), s('week', now - 5 * day), s('old', now - 30 * day)],
      now,
    )
    expect(groups.map((g) => g.label)).toEqual(['今日', '昨日', '过去 7 天', '更早'])
    expect(groups[0].items.map((x) => x.sessionId)).toEqual(['today'])
    expect(groups[3].items.map((x) => x.sessionId)).toEqual(['old'])
  })

  it('全部为空 → 空数组（无组头）', () => {
    expect(groupSessionsByTime([], now)).toEqual([])
  })

  it('今天 0 点边界：恰为今日 0 点整算今日，昨日 0 点前算昨日', () => {
    const groups = groupSessionsByTime([s('edge', startOfToday(now), undefined), s('yday', startOfToday(now) - 1)], now)
    expect(groups[0].items.map((x) => x.sessionId)).toEqual(['edge'])
    expect(groups[1].items.map((x) => x.sessionId)).toEqual(['yday'])
  })
})

function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

describe('searchSessions', () => {
  const data = [s('a1', 1, '窗外的雨'), s('a2', 2, '山中的雾'), s('b3', 3, 'README 调研')]

  it('标题子串命中（大小写不敏感）', () => {
    expect(searchSessions(data, '雨').map((x) => x.sessionId)).toEqual(['a1'])
    expect(searchSessions(data, 'README').map((x) => x.sessionId)).toEqual(['b3'])
    expect(searchSessions(data, 'readme').map((x) => x.sessionId)).toEqual(['b3'])
  })

  it('sessionId 也参与匹配；空串返回全部', () => {
    expect(searchSessions(data, 'A2').map((x) => x.sessionId)).toEqual(['a2'])
    expect(searchSessions(data, '').length).toBe(3)
  })
})

describe('splitArchived / displayTitle', () => {
  it('归档拆分：active 不含 archived，archived 只含 archived', () => {
    const data = [s('live', 1, '在用'), s('gone', 2, '旧会话', true)]
    const { active, archived } = splitArchived(data)
    expect(active.map((x) => x.sessionId)).toEqual(['live'])
    expect(archived.map((x) => x.sessionId)).toEqual(['gone'])
  })

  it('displayTitle：空标题回退 sessionId 尾 12 字符', () => {
    expect(displayTitle({ sessionId: '2026-08-30T06-23-57-388Z-a7384c15', title: '', updatedAt: 0, running: false })).toBe('88Z-a7384c15')
    expect(displayTitle({ sessionId: 'x', title: '有名字', updatedAt: 0, running: false })).toBe('有名字')
  })
})
