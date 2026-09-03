import { describe, expect, it } from 'vitest'
import { deriveNoticeLine, groupNotices, isFresh, pushNotice, renderNoticeLine, NOTICE_LIMIT, NOTICE_TTL_MS, type NoticeItem } from '../../src/tui/notices.js'
import stringWidth from 'string-width'

function mk(level: NoticeItem['level'], text: string, id: number, at = 1000): NoticeItem {
  return { id, level, text, at }
}

describe('pushNotice（队列）', () => {
  it('追加 + 同文本去重（at 缺省 Date.now 注入）', () => {
    let list = pushNotice([], 1, 'warn', '限流')
    list = pushNotice(list, 2, 'warn', '限流')
    expect(list).toHaveLength(1)
    list = pushNotice(list, 3, 'info', '已压缩')
    expect(list).toHaveLength(2)
    expect(list[0]?.at).toBeGreaterThan(0)
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

  it('2026-09-03 sticky：无 info/warn 可淘汰时也不丢 sticky（淘汰池豁免真锁）', () => {
    // 审阅修复批（P0-4）：原用例用 info 填满——sticky 根本不在淘汰射程，旧淘汰逻辑（sticky
    // 参与 slice(1) 兜底）下也通过（实证）＝不锁豁免行为。换成 error 填满：淘汰池只能从
    // 非 sticky error 里挑，旧逻辑会切掉最旧的 sticky（用例红）
    let list = pushNotice([], 1, 'error', 'sticky-oldest', 1000, true)
    for (let i = 0; i < NOTICE_LIMIT; i++) {
      list = pushNotice(list, i + 2, 'error', `err-${i}`)
    }
    expect(list.length).toBeLessThanOrEqual(NOTICE_LIMIT)
    expect(list.some((n) => n.text === 'sticky-oldest' && n.sticky === true)).toBe(true)
    expect(list.some((n) => n.text === 'err-0')).toBe(false) // 淘汰的是最旧非 sticky error
  })

  it('sticky 字段记录：默认 false 不写字段（序列化干净）', () => {
    const list = pushNotice([], 1, 'error', '普通 error')
    expect(list[0]?.sticky).toBeUndefined()
  })
})

describe('isFresh + deriveNoticeLine TTL（F-38：临时提示到期自动退场）', () => {
  it('error 常驻（TTL undefined 恒 fresh）', () => {
    expect(isFresh({ id: 1, level: 'error', text: 'x', at: 0 }, Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(NOTICE_TTL_MS.error).toBeUndefined()
  })
  it('info/warn 到期判定的边界', () => {
    expect(isFresh({ id: 1, level: 'info', text: 'x', at: 1000 }, 1000 + 4999)).toBe(true)
    expect(isFresh({ id: 1, level: 'info', text: 'x', at: 1000 }, 1000 + 5000)).toBe(false)
    expect(isFresh({ id: 1, level: 'warn', text: 'x', at: 1000 }, 1000 + 11_999)).toBe(true)
    expect(isFresh({ id: 1, level: 'warn', text: 'x', at: 1000 }, 1000 + 12_000)).toBe(false)
  })
  it('过期 info 不上行（派生只看驻留期内）', () => {
    const now = 100_000
    const list = [mk('info', '刚发生', 1, now - 1000), mk('info', '已过期', 2, now - 6000)]
    const line = deriveNoticeLine(list, now)
    expect(line?.text).toBe('刚发生')
    expect(line?.rest).toBe(0) // 过期的 histories 不计入余量
  })
  it('error 永不过期——极晚时刻仍上行', () => {
    const list = [mk('error', '严重问题', 1, 0)]
    expect(deriveNoticeLine(list, Number.MAX_SAFE_INTEGER)?.text).toBe('严重问题')
  })
})

describe('deriveNoticeLine（底部行派生）', () => {
  it('空 → null', () => {
    expect(deriveNoticeLine([])).toBeNull()
  })
  it('优先高级（error 压过更新的 warn）', () => {
    const list = [mk('warn', '旧警告', 1), mk('error', '严重问题', 2), mk('warn', '新警告', 3)]
    const line = deriveNoticeLine(list, 2000)
    expect(line?.level).toBe('error')
    expect(line?.text).toBe('严重问题')
    expect(line?.rest).toBe(2)
  })
  it('同级取最新', () => {
    const line = deriveNoticeLine([mk('warn', '旧', 1), mk('warn', '新', 2)], 2000)
    expect(line?.text).toBe('新')
    expect(line?.rest).toBe(1)
  })
  it('单条无余量计数', () => {
    expect(deriveNoticeLine([mk('info', 'x', 1)], 2000)?.rest).toBe(0)
  })
})

describe('groupNotices（面板分组）', () => {
  it('按 严重→警告→提示 排序，空组剔除', () => {
    const groups = groupNotices([mk('info', 'i', 1), mk('error', 'e', 2), mk('warn', 'w', 3)])
    expect(groups.map((g) => g.level)).toEqual(['error', 'warn', 'info'])
    expect(groupNotices([mk('warn', 'w', 1)]).map((g) => g.level)).toEqual(['warn'])
  })
})

describe('renderNoticeLine（单行渲染：宽度感知 + 角标保底；F-38 图标后双空格）', () => {
  it('短消息原样 + 角标完整（中文按 2 列；图标与文字双空格不贴脸）', () => {
    const out = renderNoticeLine({ level: 'warn', text: '限流重试中', rest: 3 }, 100)
    expect(out).toBe('⚠  限流重试中 · 还有 3 条（/warnings 查看）')
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
    expect(out).toBe('ℹ  已压缩对话')
  })

  it('三级 icon 区分', () => {
    expect(renderNoticeLine({ level: 'error', text: 'x', rest: 0 }, 50).startsWith('✖')).toBe(true)
    expect(renderNoticeLine({ level: 'warn', text: 'x', rest: 0 }, 50).startsWith('⚠')).toBe(true)
    expect(renderNoticeLine({ level: 'info', text: 'x', rest: 0 }, 50).startsWith('ℹ')).toBe(true)
  })

  it('多行/制表消息折叠为单行', () => {
    const out = renderNoticeLine({ level: 'warn', text: 'a\nb\tc', rest: 0 }, 100)
    expect(out).toBe('⚠  a b c')
    expect(out.split('\n')).toHaveLength(1)
  })
})

describe('窄终端降级三档（审阅 P1-2 补测——审阅点名 cols<45 场景）', () => {
  it('cols=40：全角标放不下 → 缩为 (+N)，仍单行', () => {
    const out = renderNoticeLine({ level: 'warn', text: '限流重试中', rest: 5 }, 40)
    expect(out).toBe('⚠  限流重试中 (+5)') // 全角标 ~32 列 + icon+2 空格 + 消息 10 > 40 → 降级
    expect(stringWidth(out)).toBeLessThanOrEqual(40)
  })

  it('cols=30 短消息：(+N) 档放得下（19 列）→ 保留短角标', () => {
    const out = renderNoticeLine({ level: 'error', text: '上下文超限', rest: 99 }, 30)
    expect(out).toBe('✖  上下文超限 (+99)')
    expect(stringWidth(out)).toBeLessThanOrEqual(30)
  })

  it('cols=16 极窄：(+N) 档预算触底（<10）→ 彻底去角标，单行硬保证', () => {
    const out = renderNoticeLine({ level: 'warn', text: '超长告警消息'.repeat(10), rest: 2 }, 16)
    expect(out).not.toContain('(+2)')
    expect(out).not.toContain('/warnings')
    expect(stringWidth(out)).toBeLessThanOrEqual(16)
  })

  it('cols=60：全角标可容纳（>阈值不降级）', () => {
    const out = renderNoticeLine({ level: 'warn', text: '限流重试中', rest: 5 }, 60)
    expect(out).toContain('还有 5 条（/warnings 查看）')
  })
})
