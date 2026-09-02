/** 活动流 B4a：timelineBudget 纯函数（折叠线/摘要计数/diff 附属行计价/终态估行）。 */
import { describe, it, expect } from 'vitest'
import { timelineBudget, type TimelineEntryShape } from '../../src/tui/viewport.js'

const text = (id: string, live: boolean, chars = 10): TimelineEntryShape => ({ kind: 'text', live, text: 'x'.repeat(chars) })
const tool = (id: string, name = 'bash'): TimelineEntryShape => ({ kind: 'tool', tool: { name, status: 'done' } })
const edit = (id: string): TimelineEntryShape => ({ kind: 'tool', tool: { name: 'edit_file', status: 'done' } })

describe('timelineBudget（§5.5.7）', () => {
  it('S0 全放得下：无折叠摘要', () => {
    const out = timelineBudget([text('a', true)], 10, 80, 5)
    expect(out.foldedSummary).toBeNull()
    expect(out.visibleFrom).toBe(0)
  })

  it('S1 超预算：最老条目折叠，最新保住（「显示最新的，其余的折叠」）', () => {
    // 只读工具单价 2；预算 5 → 自底向上 [live(4)+tool2(2)] 已 6>5 → tool2 起折叠
    const entries = [tool('t1'), tool('t2'), text('x', true)]
    const out = timelineBudget(entries, 5, 80, 4)
    expect(out.visibleFrom).toBeGreaterThan(0)
    expect(out.foldedSummary).not.toBeNull()
    expect(out.foldedSummary!.tools).toBeGreaterThanOrEqual(1)
  })

  it('diff 附属行计价（P0-1）：副作用单价含 margin 与摘要预留（R2 后=2+16+2 摘要=20 放一个）', () => {
    // 单价 = 行1+margin1+preview1+标题1+expandCap12+marker1 = 17；摘要恒预留 2 → 预算 19 恰放一个
    const one = timelineBudget([edit('e1')], 19, 80, 5)
    expect(one.foldedSummary).toBeNull()
    const two = timelineBudget([edit('e1'), edit('e2')], 19, 80, 5)
    expect(two.foldedSummary).not.toBeNull()
    expect(two.foldedSummary!.tools).toBe(1) // e1 折叠、e2 可见
  })

  it('终态估行（P0-2）：最新终态段有保守估行，老终态段按 1 行降级计', () => {
    const entries = [text('old', false, 500), text('new', false, 200)]
    const out = timelineBudget(entries, 30, 80, 5)
    expect(out.finalTextEstimate).not.toBeNull()
    expect(out.finalTextEstimate!).toBeGreaterThanOrEqual(4) // 200 字/78 宽 ≈ 3 行 ×1.3+2
  })

  it('thinking 条目单价 2 行（R2 后含 margin 1）', () => {
    const entries: TimelineEntryShape[] = [{ kind: 'thinking', endedAt: 1 }, { kind: 'thinking', endedAt: 2 }, { kind: 'thinking', endedAt: 3 }]
    const ok = timelineBudget(entries, 8, 80, 3) // 摘要 2 + 3×2 = 8 恰好
    expect(ok.foldedSummary).toBeNull()
    const fold = timelineBudget(entries, 7, 80, 3)
    expect(fold.foldedSummary).not.toBeNull()
  })

  it('R2/P0-1：最新条目就放不下 → 全折叠（broke 区分——旧实现误判全可见反向全量渲染）', () => {
    const out = timelineBudget([{ kind: 'tool', tool: { name: 'bash', status: 'done' } }, edit('e1')], 9, 80, 5)
    expect(out.foldedSummary).not.toBeNull()
    expect(out.foldedSummary!.tools).toBe(2) // 全折叠，只剩摘要行
    expect(out.visibleFrom).toBe(2)
  })
})
