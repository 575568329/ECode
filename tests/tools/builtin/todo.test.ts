/**
 * todo 工具测（M11-P6）：AJV 边界 + 全量替换语义返回 + ToolGroupView 渲染。
 */
import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { todoTool } from '../../../src/tools/builtin/todo.js'
import { ToolRegistryImpl } from '../../../src/tools/registry.js'
import { ToolGroupView } from '../../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../../src/tui/types.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

const reg = new ToolRegistryImpl()
reg.register(todoTool)

const todoCall = (todos: Array<{ content: string; status: string }>): ActiveTool => ({
  name: 'todo',
  use: { type: 'tool_use', id: 'tu1', name: 'todo', input: { todos } },
  result: { type: 'tool_result', tool_use_id: 'tu1', content: '清单已更新', is_error: false },
  status: 'done',
})

describe('todo 工具（AJV 边界）', () => {
  it('合法清单通过并返回完成度确认文本', async () => {
    const v = reg.validate('todo', { todos: [{ content: '重构 A', status: 'completed' }, { content: '写测试 B', status: 'in_progress' }] })
    expect(v.ok).toBe(true)
    const r = await todoTool.execute({ todos: [{ content: '重构 A', status: 'completed' }, { content: '写测试 B', status: 'in_progress' }] }, { cwd: '.', signal: new AbortController().signal })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('1/2 完成')
    expect(r.content).toContain('写测试 B')
  })
  it('空 content 拒绝', () => {
    expect(reg.validate('todo', { todos: [{ content: '', status: 'pending' }] }).ok).toBe(false)
  })
  it('非法 status 拒绝', () => {
    expect(reg.validate('todo', { todos: [{ content: 'x', status: 'doing' }] }).ok).toBe(false)
  })
  it('超 20 项拒绝', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ content: `项${i}`, status: 'pending' }))
    expect(reg.validate('todo', { todos: many }).ok).toBe(false)
  })
  it('content 超 200 字符拒绝', () => {
    expect(reg.validate('todo', { todos: [{ content: 'x'.repeat(201), status: 'pending' }] }).ok).toBe(false)
  })
})

describe('ToolGroupView todo 渲染（M11-P6）', () => {
  it('折叠/展开态都只留「N/M 完成」摘要行；清单本体不进对话流（0b60219 已移 TodoPanel）', () => {
    const call = todoCall([
      { content: '重构 loop', status: 'completed' },
      { content: '写测试', status: 'in_progress' },
      { content: '更新文档', status: 'pending' },
    ])
    const folded = render(React.createElement(ToolGroupView, { tools: [call] }))
    expect(folded.lastFrame()).toContain('1/3 完成')

    // 对标拍板「清单不进 transcript」：展开态不再渲染逐项 [x]/[->]/[ ]（本体在 TodoPanel，
    // 见 tests/tui/TodoPanel.test.tsx）——此前断言展开态逐项是 0b60219 改造后的漂移
    const expanded = render(React.createElement(ToolGroupView, { tools: [call], expanded: true }))
    const frame = expanded.lastFrame() ?? ''
    expect(frame).toContain('1/3 完成')
    expect(frame).not.toContain('[x] 重构 loop')
    expect(frame).not.toContain('[->] 写测试')
  })
})
