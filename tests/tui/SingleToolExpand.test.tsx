/**
 * 界面批 B1：单工具级展开（Ctrl+E 循环）。
 * - nextSingleExpand 纯函数（types.ts）
 * - ToolGroupView expandedIds 渲染（命中工具展开全文、其余收起）
 */
import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { nextSingleExpand } from '../../src/tui/types.js'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../src/tui/types.js'
import type { ToolUseBlock, ToolResultBlock } from '../../src/core/types.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const mkTool = (id: string, name: string, content: string): ActiveTool => ({
  name,
  use: { type: 'tool_use', id, name, input: {} } as ToolUseBlock,
  result: { type: 'tool_result', tool_use_id: id, content } as ToolResultBlock,
  status: 'done',
})

describe('nextSingleExpand（B1 循环选中）', () => {
  const tools = [mkTool('a', 'bash', 'A 输出全文行1\n行2'), mkTool('b', 'read_file', 'B 内容行1\n行2'), mkTool('c', 'grep', 'C 命中行1\n行2')]

  it('空态 → 展开第一个', () => {
    const next = nextSingleExpand(tools, new Set())
    expect([...next]).toEqual(['a'])
  })
  it('已展开 a → 展开 b（循环下一个）', () => {
    const next = nextSingleExpand(tools, new Set(['a']))
    expect([...next]).toEqual(['b'])
  })
  it('已展开 c（最后一个）→ 回绕展开 a（循环语义，非重置）', () => {
    const next = nextSingleExpand(tools, new Set(['c']))
    expect([...next]).toEqual(['a'])
  })
  it('全展开（a+b+c）→ 全收起重置', () => {
    const next = nextSingleExpand(tools, new Set(['a', 'b', 'c']))
    expect(next.size).toBe(0)
  })
  it('无 done 工具 → 原样返回', () => {
    const empty: Array<{ use?: { id: string } }> = []
    const cur = new Set(['x'])
    expect(nextSingleExpand(empty, cur)).toBe(cur)
  })
  it('running 工具（无 use）跳过', () => {
    const withRunning: Array<{ use?: { id: string } }> = [{ name: 'r' }, { use: { id: 'd' } }]
    const next = nextSingleExpand(withRunning, new Set())
    expect([...next]).toEqual(['d'])
  })
})

describe('ToolGroupView expandedIds（B1 单选展开渲染）', () => {
  const tools = [mkTool('a', 'bash', 'COMMAND_A\nOUT_A_LINE_1\nOUT_A_LINE_2'), mkTool('b', 'grep', 'PAT\nOUT_B')]

  it('expandedIds 命中 a → a 展开显示输出全文，b 仍收起 preview', () => {
    const { lastFrame } = render(
      React.createElement(ToolGroupView, { tools, expandedIds: new Set(['a']) }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('OUT_A_LINE_1')
    expect(f).toContain('OUT_A_LINE_2')
    expect(f).not.toContain('OUT_B')
  })
  it('不传 expandedIds → 全收起（现状回归）', () => {
    const { lastFrame } = render(React.createElement(ToolGroupView, { tools }))
    const f = lastFrame() ?? ''
    expect(f).not.toContain('OUT_A_LINE_1')
    expect(f).not.toContain('OUT_B')
  })
})
