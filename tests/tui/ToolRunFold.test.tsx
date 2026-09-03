/**
 * 同名工具折叠（2026-09-03 用户拍板「相同的工具能折叠也折叠起来——占位太大」）：
 * - 动态区：连续同名 tool run（≥3 且被折叠者全终态）折叠为「×N 摘要行 + 最新 1 条完整」，
 *   计价同步（tool-run 单价 2 行）——预算与渲染同源不破。
 * - Static：同名 readonly 组紧凑态（组头 ×N + 单行/条 + 还有 N 条）；副作用组（edit/write）
 *   不折叠——D15「diff 必须显示全」语义保持。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { TimelineView } from '../../src/tui/TimelineView.js'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import { collapseSameToolRuns, TOOL_RUN_FOLD_MIN } from '../../src/tui/viewport.js'
import type { TimelineEntry } from '../../src/protocol/timeline.js'
import type { ActiveTool } from '../../src/tui/types.js'

afterEach(() => cleanup)

const bashEntry = (id: string, status: 'running' | 'done' | 'error' = 'done'): TimelineEntry => ({
  kind: 'tool',
  id,
  tool: { name: 'bash', id, status, digest: `grep -rn "k${id}" src/`, content: `src/a.ts:1 hit-${id}` },
})

describe('同名工具折叠：collapseSameToolRuns（纯函数）', () => {
  it('连续同名 ≥3 且被折叠者全终态 → [×(N-1) 摘要, 最新原样]', () => {
    const out = collapseSameToolRuns([bashEntry('t1'), bashEntry('t2'), bashEntry('t3'), bashEntry('t4')])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ kind: 'tool-run', name: 'bash', count: 3 })
    expect(out[1]).toMatchObject({ kind: 'tool', id: 't4' })
  })

  it('被折叠者含 running → 不折叠（并行只读批的活态逐条可见）', () => {
    const out = collapseSameToolRuns([bashEntry('t1', 'running'), bashEntry('t2'), bashEntry('t3')])
    expect(out.every((e) => e.kind === 'tool')).toBe(true)
    expect(out).toHaveLength(3)
  })

  it('异名打断 / 长度 < TOOL_RUN_FOLD_MIN 不折叠 / 副作用工具（edit_file）恒不折叠', () => {
    expect(collapseSameToolRuns([bashEntry('t1'), bashEntry('t2'), bashEntry('t3')]).every((e) => e.kind === 'tool')).toBe(false)
    const short = collapseSameToolRuns([bashEntry('t1'), bashEntry('t2')])
    expect(short.every((e) => e.kind === 'tool')).toBe(true)
    const edits: TimelineEntry[] = ['e1', 'e2', 'e3', 'e4'].map((id) => ({
      kind: 'tool',
      id,
      tool: { name: 'edit_file', id, status: 'done', digest: `fix-${id}` },
    }))
    expect(collapseSameToolRuns(edits).every((e) => e.kind === 'tool')).toBe(true)
    expect(TOOL_RUN_FOLD_MIN).toBe(3)
  })

  it('text/thinking 打断 run（语义边界）', () => {
    const withText: TimelineEntry[] = [
      bashEntry('t1'),
      bashEntry('t2'),
      { kind: 'text', id: 'x1', text: '说明', live: false },
      bashEntry('t3'),
      bashEntry('t4'),
    ]
    const out = collapseSameToolRuns(withText)
    expect(out.filter((e) => e.kind === 'tool-run')).toHaveLength(0)
  })

  it('error 计入摘要（×N · M 失败）', () => {
    const out = collapseSameToolRuns([bashEntry('t1', 'error'), bashEntry('t2', 'error'), bashEntry('t3')])
    expect(out[0]).toMatchObject({ kind: 'tool-run', count: 2, errors: 2 })
  })
})

describe('同名工具折叠：TimelineView 动态区渲染', () => {
  it('4 连发 bash → 「×3 已折叠」摘要行 + 最新一条完整（digest 只出现最新）', () => {
    const timeline = [bashEntry('t1'), bashEntry('t2'), bashEntry('t3'), bashEntry('t4')]
    const { lastFrame } = render(React.createElement(TimelineView, { timeline, lines: 12, liveMaxLines: 4 }))
    const f = lastFrame() ?? ''
    expect(f).toContain('bash ×3 已折叠')
    expect(f).toContain('"kt4"') // 最新条 digest 完整渲染
    expect(f).not.toContain('"kt1"') // 被折叠条不渲染
  })

  it('计价协同：8 连发在小预算（lines=7）下不被头部折叠吃掉（摘要+最新可见）', () => {
    const timeline = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id) => bashEntry(id))
    const { lastFrame } = render(React.createElement(TimelineView, { timeline, lines: 7, liveMaxLines: 4 }))
    const f = lastFrame() ?? ''
    expect(f).toContain('bash ×7 已折叠')
    expect(f).toContain('"kt8"')
    expect(f).not.toContain('本轮前段') // 预算头部折叠未触发（折叠计价生效）
  })

  it('run 尾是 running → 最新运行条完整渲染（活态可见）', () => {
    const timeline = [bashEntry('t1'), bashEntry('t2'), bashEntry('t3'), bashEntry('t4', 'running')]
    const { lastFrame } = render(React.createElement(TimelineView, { timeline, lines: 12, liveMaxLines: 4 }))
    const f = lastFrame() ?? ''
    expect(f).toContain('bash ×3 已折叠')
    expect(f).toContain('正在执行')
  })
})

/** Static 组紧凑态用的 ActiveTool 构造 */
const call = (id: string, name: string, content = 'result line'): ActiveTool => ({
  name,
  use: { type: 'tool_use', id, name, input: name === 'bash' ? { command: `cmd-${id}` } : { path: `p-${id}` } },
  result: { type: 'tool_result', tool_use_id: id, content },
  status: 'done',
})

describe('同名工具折叠：ToolGroupView 静态紧凑态', () => {
  it('同名 readonly 组 → 组头「bash ×4」+ 单行/条 + 「还有 N 条」', () => {
    const tools = ['a', 'b', 'c', 'd'].map((id) => call(id, 'bash', `out-${id}`))
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    const f = lastFrame() ?? ''
    expect(f).toContain('bash ×4')
    expect(f).not.toContain('4 个工具') // 旧组头形态退役（同名紧凑态）
    expect(f).toContain('cmd-a') // 可见条单行 digest
    expect(f).toContain('out-b') // 同行 preview
    expect(f).toContain('还有 2 条')
    expect(f).toContain('Ctrl+T')
  })

  it('含失败 → 组头带「N 失败」', () => {
    const tools: ActiveTool[] = [
      call('a', 'bash'),
      { ...call('b', 'bash'), status: 'error', result: { type: 'tool_result', tool_use_id: 'b', content: 'boom' } },
      call('c', 'bash'),
      call('d', 'bash'),
    ]
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    expect(lastFrame() ?? '').toContain('bash ×4 · 1 失败')
  })

  it('副作用组（edit_file）不进紧凑态：旧组头 + diff 全量（D15 保持）', () => {
    const tools = ['a', 'b', 'c'].map((id) => call(id, 'edit_file', `+ added line ${id}`))
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    const f = lastFrame() ?? ''
    expect(f).toContain('3 个工具') // 旧组头保留
    expect(f).not.toContain('×3')
    expect(f).toContain('+ added line a') // diff 正文全量（可见前 2 条之一）
  })

  it('异名组不进紧凑态（旧渲染保持）', () => {
    const tools = [call('a', 'bash'), call('b', 'grep')]
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    expect(lastFrame() ?? '').toContain('2 个工具')
  })
})
