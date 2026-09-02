/** F-06：展开态输出头部时间标记（历史快照不再误读为当前状态）——标记走 V 线预算（追加在既有"▾ 输出"行内，不新增行）。
 *  活动流 B4/R2 后展开态语义：副作用工具（edit_file/write_file）Static 恒自动展开；
 *  只读工具 Static 恒收起（▸ preview）——全文回看走 Ctrl+T。 */
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../src/tui/types.js'
afterEach(() => cleanup())

function tool(at?: number): ActiveTool {
  return {
    name: 'edit_file',
    status: 'done',
    use: { id: 'u1', name: 'edit_file', input: { path: 'a.ts' } },
    result: { type: 'tool_result', tool_use_id: 'u1', content: '已更新 a.ts（1 处）\n+const x = 1', is_error: false },
    ...(at !== undefined ? { at } : {}),
  }
}

describe('F-06 展开态时间标记', () => {
  it('有 at 时展开头部行内带 · HH:MM', () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools: [tool(at)] }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▾ 输出')
    expect(frame).toMatch(/输出 \(.*\) · 09:05/)
    // 不新增行：标记与"▾ 输出"同行
    const line = frame.split('\n').find((l) => l.includes('输出')) ?? ''
    expect(line).toContain('09:05')
  })
  it('无 at（Static 固化/旧数据）不显示标记、不炸', () => {
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools: [tool()] }))
    expect(lastFrame()).toContain('▾ 输出')
    const line = lastFrame()?.split('\n').find((l) => l.includes('输出')) ?? ''
    expect(line).not.toContain('·')
  })
})
