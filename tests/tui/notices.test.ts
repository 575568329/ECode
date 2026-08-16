import { describe, expect, it } from 'vitest'
import { deriveNoticeLine, groupNotices, pushNotice, NOTICE_LIMIT, type NoticeItem } from '../../src/tui/notices.js'

function mk(level: NoticeItem['level'], text: string, id: number): NoticeItem {
  return { id, level, text }
}

describe('pushNotice（队列）', () => {
  it('追加 + 同文本去重', () => {
    let list = pushNotice([], 1, 'warn', '限流')
    list = pushNotice(list, 2, 'warn', '限流')
    expect(list).toHaveLength(1)
    list = pushNotice(list, 3, 'info', '已压缩')
    expect(list).toHaveLength(2)
  })

  it('封顶淘汰：优先丢 info，同级丢最旧', () => {
    let list: NoticeItem[] = []
    for (let i = 0; i < NOTICE_LIMIT + 3; i++) {
      list = pushNotice(list, i, i < 10 ? 'warn' : 'info', `msg-${i}`)
    }
    expect(list.length).toBeLessThanOrEqual(NOTICE_LIMIT)
    // 最早的 info（msg-10）被淘汰；warn 全保留
    expect(list.some((n) => n.text === 'msg-10')).toBe(false)
    expect(list.some((n) => n.text === 'msg-0')).toBe(true)
  })
})

describe('deriveNoticeLine（底部行派生）', () => {
  it('空 → null', () => {
    expect(deriveNoticeLine([])).toBeNull()
  })
  it('优先高级（error 压过更新的 warn）', () => {
    const list = [mk('warn', '旧警告', 1), mk('error', '严重问题', 2), mk('warn', '新警告', 3)]
    const line = deriveNoticeLine(list)
    expect(line?.level).toBe('error')
    expect(line?.text).toBe('严重问题')
    expect(line?.rest).toBe(2)
  })
  it('同级取最新', () => {
    const line = deriveNoticeLine([mk('warn', '旧', 1), mk('warn', '新', 2)])
    expect(line?.text).toBe('新')
    expect(line?.rest).toBe(1)
  })
  it('单条无余量计数', () => {
    expect(deriveNoticeLine([mk('info', 'x', 1)])?.rest).toBe(0)
  })
})

describe('groupNotices（面板分组）', () => {
  it('按 严重→警告→提示 排序，空组剔除', () => {
    const groups = groupNotices([mk('info', 'i', 1), mk('error', 'e', 2), mk('warn', 'w', 3)])
    expect(groups.map((g) => g.level)).toEqual(['error', 'warn', 'info'])
    expect(groupNotices([mk('warn', 'w', 1)]).map((g) => g.level)).toEqual(['warn'])
  })
})
