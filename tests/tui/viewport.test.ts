import { describe, expect, it } from 'vitest'
import { MIN_BUDGET, computeBudget, foldLines, sectionBudget, allocateDynamic } from '../../src/tui/viewport.js'

describe('computeBudget 帧高预算', () => {
  it('rows 减安全余量（Windows 恰满屏也触发全清 ink #969）', () => {
    expect(computeBudget(30)).toBe(28)
    expect(computeBudget(24)).toBe(22)
  })

  it('极矮终端预算下限', () => {
    expect(computeBudget(9)).toBe(MIN_BUDGET)
    expect(computeBudget(2)).toBe(MIN_BUDGET)
  })
})

describe('sectionBudget 各段预算单一公式', () => {
  it('budget 减预留，cap 封顶', () => {
    expect(sectionBudget(28, 12, 12)).toBe(12)
    expect(sectionBudget(20, 12, 12)).toBe(8)
    expect(sectionBudget(28, 0)).toBe(28)
  })

  it('下限 1（组件自己的极矮保命线在调用侧 Math.max）', () => {
    expect(sectionBudget(10, 12, 12)).toBe(1)
  })
})

describe('foldLines 物理行折叠', () => {
  it('不超窗原样返回', () => {
    const r = foldLines('a\nb\nc', 5, 40)
    expect(r.visible).toEqual(['a', 'b', 'c'])
    expect(r.foldedCount).toBe(0)
    expect(r.markerAt).toBe(0)
    expect(r.totalPhysical).toBe(3)
  })

  it('tail 模式留尾部', () => {
    const r = foldLines('1\n2\n3\n4\n5', 3, 40)
    expect(r.visible).toEqual(['3', '4', '5'])
    expect(r.foldedCount).toBe(2)
    expect(r.markerAt).toBe(0)
  })

  it('head-tail 默认头 3 行', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`)
    const r = foldLines(lines.join('\n'), 6, 40, 'head-tail')
    expect(r.visible).toEqual(['L0', 'L1', 'L2', 'L7', 'L8', 'L9'])
    expect(r.markerAt).toBe(3)
    expect(r.foldedCount).toBe(4)
    expect(r.totalPhysical).toBe(10)
  })

  it('keep.head 超窗被钳制（至少给尾段留 1 行）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`)
    const r = foldLines(lines.join('\n'), 4, 40, 'head-tail', { head: 5 })
    expect(r.visible).toEqual(['L0', 'L1', 'L2', 'L9'])
    expect(r.markerAt).toBe(3)
  })

  it('head-tail 窗宽 1 退化为 tail', () => {
    const r = foldLines('1\n2\n3', 1, 40, 'head-tail')
    expect(r.visible).toEqual(['3'])
    expect(r.markerAt).toBe(0)
  })

  it('超长单行按宽度 wrap 成物理行（治 minified JSON/长 URL 爆行）', () => {
    const r = foldLines('x'.repeat(100), 2, 30)
    expect(r.totalPhysical).toBe(4)
    expect(r.visible).toEqual(['x'.repeat(30), 'x'.repeat(10)])
  })

  it('CJK 宽度感知（中 = 2 列）', () => {
    const r = foldLines('中'.repeat(45), 2, 20)
    expect(r.totalPhysical).toBe(5)
  })

  it('emoji 宽度感知（👍 = 2 列）', () => {
    const r = foldLines('👍'.repeat(10), 3, 8)
    expect(r.totalPhysical).toBe(3)
  })

  it('空串按单行处理', () => {
    const r = foldLines('', 3, 40)
    expect(r.totalPhysical).toBe(1)
    expect(r.visible).toEqual([''])
    expect(r.foldedCount).toBe(0)
  })

  it('空行保留占位', () => {
    const r = foldLines('a\n\nb', 5, 40)
    expect(r.visible).toEqual(['a', '', 'b'])
  })

  it('ANSI 码 wrap 不破坏（SGR 序列保留）', () => {
    const red = `\u001b[31m${'r'.repeat(70)}\u001b[0m`
    const r = foldLines(red, 5, 30)
    expect(r.totalPhysical).toBe(3)
    expect(r.visible[0]).toContain('\u001b[31m')
    expect(r.visible.join('')).toContain('\u001b[0m')
  })

  it('ambiguous 字符按窄宽计（± = 1 列，与 Ink 布局口径一致——M14 §6 钉测试）', () => {
    const r = foldLines('±'.repeat(40), 5, 20)
    expect(r.totalPhysical).toBe(2)
  })

  it('width 非法（≤0）不 wrap 仅按逻辑行切窗', () => {
    const r = foldLines('abc\n def\nghi', 2, 0)
    expect(r.totalPhysical).toBe(3)
    expect(r.visible).toEqual([' def', 'ghi'])
  })
})

describe('M14-V5 allocateDynamic（动态区总守卫分配）', () => {
  it('退化保护：budget < 退化线全降级（宁可不显示也不触发 3J；活动流 B4 加 timelineLines 字段）', () => {
    expect(allocateDynamic(8)).toEqual({ degraded: true, streamMaxLines: 0, toolGroupCap: 0, timelineLines: 0 })
    expect(allocateDynamic(11)).toEqual({ degraded: true, streamMaxLines: 0, toolGroupCap: 0, timelineLines: 0 })
  })
  it('24 行终端（budget 22）：工具 ≥1 组 + stream 保底 4（审阅批4 输入区实占 8 行后 24 行窗收紧）', () => {
    const a = allocateDynamic(22)
    expect(a.degraded).toBe(false)
    expect(a.toolGroupCap).toBeGreaterThanOrEqual(1)
    expect(a.streamMaxLines).toBeGreaterThanOrEqual(4)
    // 条件段感知（审阅 P1-1）：TasksBar+SubagentBar 活跃显式扣减，退化线上移
    const b = allocateDynamic(22, { tasksBar: true, subagentBar: true })
    expect(b.degraded).toBe(true) // 22 < 12+6
    const c = allocateDynamic(40, { tasksBar: true })
    expect(c.degraded).toBe(false)
    // 条件段已扣进 CHROME（8=5 骨架+3 任务条）——总和 ≤ content=40−8−8
    expect(c.toolGroupCap * 4 + c.streamMaxLines).toBeLessThanOrEqual(40 - 8 - 8)
    expect(allocateDynamic(40).streamMaxLines).toBeGreaterThan(c.streamMaxLines) // 条件段真实挤占（stream 吃弹性）
  })
  it('大终端：工具组封顶 6、stream 拿大头；总和恒 ≤ content（预算不变式）', () => {
    for (const budget of [22, 40, 60, 100]) {
      const a = allocateDynamic(budget)
      const content = Math.max(4, budget - 5 - 8)
      expect(a.toolGroupCap).toBeLessThanOrEqual(6)
      expect(a.toolGroupCap * 4 + a.streamMaxLines).toBeLessThanOrEqual(content)
    }
    expect(allocateDynamic(98).toolGroupCap).toBe(6)
    expect(allocateDynamic(98).streamMaxLines).toBeGreaterThanOrEqual(40)
  })
})
