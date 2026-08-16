import { describe, expect, it } from 'vitest'
import { deriveNoticeLine, groupNotices, pushNotice, renderNoticeLine, NOTICE_LIMIT, type NoticeItem } from '../../src/tui/notices.js'
import stringWidth from 'string-width'

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

describe('renderNoticeLine（单行渲染：宽度感知 + 角标保底）', () => {
  it('短消息原样 + 角标完整（中文按 2 列）', () => {
    const out = renderNoticeLine({ level: 'warn', text: '限流重试中', rest: 3 }, 100)
    expect(out).toBe('⚠ 限流重试中 · 还有 3 条（/warnings 查看）')
  })

  it('超长中文消息截断但角标完整保留（不被挤掉）', () => {
    const long = '限流'.repeat(200) // 800 列宽
    const out = renderNoticeLine({ level: 'error', text: long, rest: 7 }, 80)
    expect(out).toContain('还有 7 条（/warnings 查看）') // 角标完整
    expect(out.endsWith('…')).toBe(false)
    expect(out.includes('… · 还有 7 条')).toBe(true) // 截断点在消息本体
    // 总显示宽度不超终端（单行不换行的硬保证）
    const w = stringWidth(out)
    expect(w).toBeLessThanOrEqual(80)
  })

  it('rest=0 无角标，全额给消息', () => {
    const out = renderNoticeLine({ level: 'info', text: '已压缩对话', rest: 0 }, 100)
    expect(out).toBe('ℹ 已压缩对话')
  })

  it('三级 icon 区分', () => {
    expect(renderNoticeLine({ level: 'error', text: 'x', rest: 0 }, 50).startsWith('✖')).toBe(true)
    expect(renderNoticeLine({ level: 'warn', text: 'x', rest: 0 }, 50).startsWith('⚠')).toBe(true)
    expect(renderNoticeLine({ level: 'info', text: 'x', rest: 0 }, 50).startsWith('ℹ')).toBe(true)
  })

  it('多行/制表消息折叠为单行', () => {
    const out = renderNoticeLine({ level: 'warn', text: 'a\nb\tc', rest: 0 }, 100)
    expect(out).toBe('⚠ a b c')
    expect(out.split('\n')).toHaveLength(1)
  })
})
