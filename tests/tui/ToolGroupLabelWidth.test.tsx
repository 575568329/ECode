import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../src/tui/types.js'
afterEach(() => cleanup())
function makeTool(name: string): ActiveTool {
  return { name, status: 'done', result: { content: 'ok' } }
}
describe('F-09 工具组行标签不截断', () => {
  it.each([['bash'], ['grep'], ['edit_file'], ['write_file']])('%s 完整显示', (name) => {
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools: [makeTool(name)] }))
    expect(lastFrame()).toContain(name)
  })
  it('窄终端下 bash 标签仍完整', async () => {
    const { lastFrame, rerender } = render(React.createElement(ToolGroupView, { tools: [makeTool('bash')] }))
    process.stdout.columns = 20
    rerender(React.createElement(ToolGroupView, { tools: [makeTool('bash')] }))
    expect(lastFrame()).toContain('bash')
    delete process.stdout.columns
  })
  // 清账 III P2-5：真正触发 clipWidth 路径——多长名拼接超 columns-14 预算，验证截断以 … 收口
  // 而非整行丢失（原窄列用例只放了一个 'bash'，stringWidth 远小于预算，clipWidth 提前 return 未执行）
  it('超长名列表触发 clipWidth：以 … 收口且帧不丢行', () => {
    const names = ['write_file', 'read_file', 'edit_file', 'bash_tool_long', 'grep_tool_long']
    const tools = names.map((n) => makeTool(n))
    process.stdout.columns = 30 // columns-14=16 预算——5 名拼接必然超宽
    try {
      const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
      const frame = lastFrame() ?? ''
      const line = frame.split('\n').find((l) => l.includes('个工具')) ?? ''
      expect(line).toContain('…') // clipWidth 真正截断（非提前 return 全文直出）
      expect(line).not.toContain('grep_tool_long') // 超预算尾部名被截掉
      expect(frame).toContain('个工具') // 行本身仍在（未整行丢失）
    } finally {
      delete process.stdout.columns
    }
  })
})

describe('F-09 表头名字串截断', () => {
  it('多工具名超宽时以省略号收口、末名不静默丢字', () => {
    const names = ['read_file', 'grep', 'write_file', 'bash', 'edit_file']
    const tools = names.map((n) => makeTool(n))
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    const frame = lastFrame() ?? ''
    // 未被 … 截到的名字完整出现；行内不再出现半截名（如 "rea"/"bas" 后不带 h）
    expect(frame).toContain('个工具')
    const shown = frame.split('\n').find((l) => l.includes('个工具')) ?? ''
    expect(shown.endsWith('…') || shown.includes('…')).toBe(true)
    // 若 bash 出现必须完整（防 bas）
    expect(shown).not.toMatch(/\bbas\b(?!h)/)
  })
})
