/**
 * 审阅 R4（回归诚实性）：App.test 假覆盖修复 + 关键链路补测
 * （TimelineView 折叠渲染/ActivityBar 单行与净化//output 负向/allocateDynamic 新账）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { TimelineView } from '../../src/tui/TimelineView.js'
import { ActivityBar } from '../../src/tui/ActivityBar.js'
import { allocateDynamic } from '../../src/tui/viewport.js'
import type { TimelineEntry } from '../../src/protocol/timeline.js'

afterEach(() => cleanup())

const tool = (id: string, name: string): TimelineEntry => ({
  kind: 'tool',
  id,
  tool: { name, id, status: 'done' },
})

describe('R4：TimelineView 渲染（审阅 P1-2 补测）', () => {
  it('超预算：折叠摘要行出现 + 最新工具可见（「显示最新的，其余的折叠」）', () => {
    const timeline: TimelineEntry[] = [tool('t1', 'bash'), tool('t2', 'read_file')]
    const { lastFrame } = render(
      React.createElement(TimelineView, { timeline, lines: 6, liveMaxLines: 4 }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('已折叠')
    expect(f).toContain('read_file') // 最新可见
    expect(f).not.toContain('bash') // 最老折叠（digest 行不渲染）
  })

  it('live thinking 不占行（渲染层跳过——§5.5.6）；ended 思考行渲染', () => {
    const timeline: TimelineEntry[] = [
      { kind: 'thinking', id: 'th1', blockIndex: 0, startedAt: 1, endedAt: 5000, durMs: 5000, text: '想完了' },
      { kind: 'thinking', id: 'th2', blockIndex: 1, startedAt: 6000, text: '正在想但不显示' },
    ]
    const { lastFrame } = render(
      React.createElement(TimelineView, { timeline, lines: 10, liveMaxLines: 4 }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('思考 · 持续了 5 秒')
    expect(f).not.toContain('正在想但不显示')
  })

  it('text→tool→text 时序保真（D1 本体——indexOf 顺序断言，P2-1 补）', () => {
    const timeline: TimelineEntry[] = [
      { kind: 'text', id: 'x1', text: '前段话', live: false },
      tool('t1', 'grep'),
      { kind: 'text', id: 'x2', text: '后段话', live: true },
    ]
    const { lastFrame } = render(
      React.createElement(TimelineView, { timeline, lines: 20, liveMaxLines: 4 }),
    )
    const f = lastFrame() ?? ''
    expect(f.indexOf('前段话')).toBeGreaterThanOrEqual(0)
    expect(f.indexOf('前段话')).toBeLessThan(f.indexOf('grep'))
    expect(f.indexOf('grep')).toBeLessThan(f.indexOf('后段话'))
  })
})

describe('R4：ActivityBar 动态化（审阅 P1-4 补测——防 3J 硬约束）', () => {
  it('detail 超 60 个 CJK 字恒单物理行（整行 clipWidth——40 字 tail 在 80 列必折 2 行的修复本体）', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'thinking', detail: '想'.repeat(60) }),
    )
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1)
  })

  it('detail 含 OSC 52 转义序列被净化（渲染口无状态 strip）', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'tool', detail: 'echo \x1b]52;c;base64\x07payload' }),
    )
    expect(lastFrame() ?? '').not.toContain('\x1b')
  })

  it('turnStartedAt 轮内耗时出现（· Ns 形态）', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'thinking', turnStartedAt: Date.now() - 3000 }),
    )
    expect(lastFrame() ?? '').toMatch(/· \d+s/)
  })
})

describe('R4：allocateDynamic 新账（审阅 P1-8 补测）', () => {
  it('timelineLines = content 份额（40 行终端 40−5−8=27）', () => {
    const a = allocateDynamic(40)
    expect(a.timelineLines).toBe(27)
    expect(a.degraded).toBe(false)
  })

  it('queuedLines 入 CHROME_RESERVE 扣减且钳到 6', () => {
    const base = allocateDynamic(40)
    const withQ = allocateDynamic(40, { queuedLines: 4 })
    expect(base.timelineLines - withQ.timelineLines).toBe(4)
    const capped = allocateDynamic(40, { queuedLines: 99 })
    expect(base.timelineLines - capped.timelineLines).toBe(6)
  })
})
