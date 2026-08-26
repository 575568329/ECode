import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import type { ActiveTool } from '../../src/tui/types.js'

/** 构造测试用 ActiveTool */
function makeTool(opts: {
  name?: string
  id?: string
  status?: 'running' | 'done' | 'error'
  input?: unknown
  content?: string
} = {}): ActiveTool {
  const id = opts.id ?? 't1'
  const name = opts.name ?? 'bash'
  const use = {
    type: 'tool_use' as const,
    id,
    name,
    input: opts.input ?? { command: 'ls' },
  }
  const status = opts.status ?? 'running'
  if (status === 'running') return { name, use, status }
  return {
    name,
    use,
    result: {
      type: 'tool_result' as const,
      tool_use_id: id,
      content: opts.content ?? 'ok',
      is_error: status === 'error',
    },
    status,
  }
}

function view(tools: ActiveTool[], expanded?: boolean): string {
  return render(React.createElement(ToolGroupView, { tools, expanded })).lastFrame() ?? ''
}

describe('ToolGroupView', () => {
  it('空数组：不渲染工具', () => {
    const f = view([])
    expect(f).not.toContain('个工具')
  })

  it('N=1：表头「1 个工具」+ 1 摘要', () => {
    const f = view([makeTool({ name: 'bash', status: 'done', id: 't1' })])
    expect(f).toContain('1 个工具')
    expect(f).toContain('bash')
    expect(f).toContain('✓')
    expect(f).not.toContain('还有')
  })

  it('N=2：表头 + 2 摘要，无溢出', () => {
    const f = view([
      makeTool({ name: 'bash', status: 'done', id: 't1' }),
      makeTool({ name: 'read_file', status: 'done', id: 't2', input: { path: 'a.ts' } }),
    ])
    expect(f).toContain('2 个工具')
    expect(f).toContain('bash')
    expect(f).toContain('read_file')
    expect(f).toContain('a.ts')
    expect(f).not.toContain('还有')
  })

  it('N=3：表头 + 前 2 摘要 + 溢出提示（+1 个 / 还有 1 个），第 3 个不可见', () => {
    const f = view([
      makeTool({ name: 'bash', status: 'done', id: 't1' }),
      makeTool({ name: 'read_file', status: 'done', id: 't2' }),
      makeTool({ name: 'grep', status: 'done', id: 't3' }),
    ])
    expect(f).toContain('3 个工具')
    expect(f).toContain('+1 个')
    expect(f).toContain('还有 1 个工具')
    expect(f).not.toContain('grep')
  })

  it('N=10：折叠态仍 4 行（+8 个 / 还有 8 个），不随 N 增长', () => {
    const tools = Array.from({ length: 10 }, (_, i) =>
      makeTool({ name: `t${i}`, status: 'done', id: `t${i}` }),
    )
    const f = view(tools)
    expect(f).toContain('10 个工具')
    expect(f).toContain('+8 个')
    expect(f).toContain('还有 8 个工具')
  })

  it('展开态：显示全部工具（N=3 时 grep 可见，无溢出提示）', () => {
    const f = view(
      [
        makeTool({ name: 'bash', status: 'done', id: 't1' }),
        makeTool({ name: 'read_file', status: 'done', id: 't2' }),
        makeTool({ name: 'grep', status: 'done', id: 't3' }),
      ],
      true,
    )
    expect(f).toContain('grep')
    expect(f).not.toContain('还有')
  })

  it('running 态：无 ✓/✗', () => {
    const f = view([makeTool({ name: 'bash', status: 'running' })])
    expect(f).toContain('bash')
    expect(f).not.toContain('✓')
    expect(f).not.toContain('✗')
  })

  it('error 态：显示 ✗', () => {
    const f = view([makeTool({ name: 'bash', status: 'error', content: '失败' })])
    expect(f).toContain('✗')
  })

  it('onToggle 传入时显示折叠标记 ▸（未展开）', () => {
    const f =
      render(
        React.createElement(ToolGroupView, { tools: [makeTool()], onToggle: () => {} }),
      ).lastFrame() ?? ''
    expect(f).toContain('▸')
  })

  it('done + 有输出：折叠态显示 ▸ preview 首行（修复：输出不再被捏掉）', () => {
    const f = view([
      makeTool({
        name: 'read_file',
        status: 'done',
        id: 't1',
        input: { path: 'pkg.json' },
        content: 'name: ecode\nversion: 0.1',
      }),
    ])
    expect(f).toContain('▸')
    expect(f).toContain('name: ecode') // preview 首行可见
  })

  it('展开态：显示 ▾ 输出 + 完整 content', () => {
    const f = view(
      [makeTool({ name: 'read_file', status: 'done', id: 't1', content: '完整文件内容' })],
      true,
    )
    expect(f).toContain('▾')
    expect(f).toContain('完整文件内容')
  })
})

describe('历史默认全收起（用户拍板：发送新对话后 Static 工具组不展开）', () => {
  it('Static 形态（不传 done）：副作用工具输出也收起（▸ preview，不显 diff 全文）', () => {
    const f = view([
      makeTool({
        name: 'edit_file',
        status: 'done',
        id: 't1',
        input: { path: 'a.ts' },
        content: '+ const x = 1\n- const y = 2',
      }),
    ])
    expect(f).toContain('▸')
    expect(f).not.toContain('▾ 输出')
  })

  it('动态区轮末（done=true）：副作用工具 diff 仍展开（看刚改了什么）', () => {
    const f =
      render(
        React.createElement(ToolGroupView, {
          tools: [makeTool({ name: 'edit_file', status: 'done', id: 't1', input: { path: 'a.ts' }, content: '+ 新行' })],
          done: true,
        }),
      ).lastFrame() ?? ''
    expect(f).toContain('▾')
    expect(f).toContain('+ 新行')
  })

  it('动态区进行中（done=false）：副作用工具收起（省空间，本轮可能多 edit）', () => {
    const f =
      render(
        React.createElement(ToolGroupView, {
          tools: [makeTool({ name: 'edit_file', status: 'running', id: 't1', input: { path: 'a.ts' } })],
          done: false,
        }),
      ).lastFrame() ?? ''
    expect(f).toContain('edit_file')
  })
})
