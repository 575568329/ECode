/** F-06：展开态输出头部时间标记（历史快照不再误读为当前状态）——标记走 V 线预算（追加在既有"▾ 输出"行内，不新增行）。 */
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../src/tui/types.js'
afterEach(() => cleanup())

function tool(at?: number): ActiveTool {
  return {
    name: 'bash',
    status: 'done',
    use: { id: 'u1', name: 'bash', input: { command: 'ls' } },
    result: { type: 'tool_result', tool_use_id: 'u1', content: 'line1\nline2', is_error: false },
    ...(at !== undefined ? { at } : {}),
  }
}

describe('F-06 展开态时间标记', () => {
  it('有 at 时展开头部行内带 · HH:MM', () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools: [tool(at)], expanded: true }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▾ 输出')
    expect(frame).toMatch(/输出 \(.*\) · 09:05/)
    // 不新增行：标记与"▾ 输出"同行
    const line = frame.split('\n').find((l) => l.includes('输出')) ?? ''
    expect(line).toContain('09:05')
  })
  it('无 at（Static 固化/旧数据）不显示标记、不炸', () => {
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools: [tool()], expanded: true }))
    expect(lastFrame()).toContain('▾ 输出')
    expect(lastFrame()).not.toContain('·')
  })
})
