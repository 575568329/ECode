import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { ToolGroupView } from '../../src/tui/ToolGroupView.js'
import { ToolLine } from '../../src/tui/ToolLine.js'
import type { ActiveTool } from '../../src/tui/types.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

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

function view(tools: ActiveTool[]): string {
  return render(React.createElement(ToolGroupView, { tools })).lastFrame() ?? ''
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

  it('running 态：无 ✓/✗；无输出行时无折叠标记（▸/▾ 只随输出行出现）', () => {
    const f = view([makeTool({ name: 'bash', status: 'running' })])
    expect(f).toContain('bash')
    expect(f).not.toContain('✓')
    expect(f).not.toContain('✗')
    // 活动流 B4/R2：交互折叠（onToggle/expanded/done props）退役——折叠标记只标输出行，
    // running 无输出则全组无 ▸/▾
    expect(f).not.toContain('▸')
    expect(f).not.toContain('▾')
  })

  it('error 态：显示 ✗', () => {
    const f = view([makeTool({ name: 'bash', status: 'error', content: '失败' })])
    expect(f).toContain('✗')
  })

  it('done + 有输出：收起态显示 ▸ preview 首行（修复：输出不再被捏掉）', () => {
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
    expect(f).not.toContain('▾ 输出') // 只读工具 Static 恒收起——全文回看走 Ctrl+T（D14）
  })
})

describe('M14-V5 maxTools 上限（总守卫 API——c8898cd 薄壳化后的新折叠面）', () => {
  const three = () => [
    makeTool({ name: 'bash', status: 'done', id: 't1' }),
    makeTool({ name: 'read_file', status: 'done', id: 't2' }),
    makeTool({ name: 'grep', status: 'done', id: 't3' }),
  ]

  it('maxTools 与组内可见数叠乘：N=3 全可见上限仍受 MAX_TOOL_VISIBLE=2 约束（+1 个）', () => {
    const f =
      render(React.createElement(ToolGroupView, { tools: three(), maxTools: 3 })).lastFrame() ?? ''
    expect(f).toContain('3 个工具')
    expect(f).not.toContain('因终端预算折叠')
  })

  it('maxTools=1：预算折叠提示（Ctrl+T 指路）+ 只显示第 1 个', () => {
    const f =
      render(React.createElement(ToolGroupView, { tools: three(), maxTools: 1 })).lastFrame() ?? ''
    expect(f).toContain('1 个工具')
    expect(f).toContain('…还有 2 个工具因终端预算折叠')
    expect(f).not.toContain('read_file')
  })

  it('maxTools=0：单行折叠提示即返回（不渲「0 个工具」空组头）', () => {
    const f =
      render(React.createElement(ToolGroupView, { tools: three(), maxTools: 0 })).lastFrame() ?? ''
    expect(f).toContain('3 个工具已折叠')
    expect(f).not.toContain('0 个工具')
  })
})

describe('副作用 diff 可见性（2026-08-29 翻案：Static 不再黑盒——「改了文件不显示 diff」用户点名）', () => {
  const editContent = '已更新 a.ts（1 处）\n\n--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const y = 2\n+const x = 1'

  it('Static 形态：edit_file 展开 diff（▾ 输出 + +/- 行可见，不再只给 ▸ preview）', () => {
    const f = view([
      makeTool({
        name: 'edit_file',
        status: 'done',
        id: 't1',
        input: { path: 'a.ts' },
        content: editContent,
      }),
    ])
    expect(f).toContain('▾')
    expect(f).toContain('+const x = 1')
    expect(f).toContain('-const y = 2')
    expect(f).not.toContain('▸')
  })

  it('Static 形态：只读工具仍收起固化（▸ preview，不显全文）', () => {
    const f = view([
      makeTool({ name: 'read_file', status: 'done', id: 't1', input: { path: 'p.json' }, content: 'a\nb\nc' }),
    ])
    expect(f).toContain('▸')
    expect(f).not.toContain('▾ 输出')
  })

  it('超长 diff Static 全量渲染不折叠（2026-08-29 再拍板「diff 必须显示全」；只读工具仍 head-tail 封顶）', () => {
    const bigDiff = Array.from({ length: 40 }, (_, i) => `+added-${i}`).join('\n')
    const f = view([
      makeTool({ name: 'edit_file', status: 'done', id: 't1', input: { path: 'a.ts' }, content: bigDiff }),
    ])
    expect(f).toContain('added-0') // 首行
    expect(f).toContain('added-20') // 中段（不再折叠）
    expect(f).toContain('added-39') // 尾行
    expect(f).not.toContain('行已折叠')
  })
})

describe('ToolLine mode 契约（活动流 D15：动态区副作用完成后自动展开受 expandCap 封顶，轮末 Static 全量补偿）', () => {
  const bigDiff = Array.from({ length: 40 }, (_, i) => `+line-${i}`).join('\n')
  const editDone = (): ActiveTool => ({
    name: 'edit_file',
    status: 'done',
    use: { type: 'tool_use', id: 'u1', name: 'edit_file', input: { path: 'a.ts' } },
    result: { type: 'tool_result', tool_use_id: 'u1', content: bigDiff, is_error: false },
  })
  const bashDone = (content: string): ActiveTool => ({
    name: 'bash',
    status: 'done',
    use: { type: 'tool_use', id: 'u2', name: 'bash', input: {} },
    result: { type: 'tool_result', tool_use_id: 'u2', content, is_error: false },
  })

  it("mode='dynamic'：副作用 done 展开 + head-tail 封顶（cap=min(12, floor(22/2))=11——头3+尾8，中段折叠）", () => {
    const { lastFrame } = render(React.createElement(ToolLine, { tool: editDone(), mode: 'dynamic' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▾ 输出')
    expect(frame).toContain('line-0') // 头段保留
    expect(frame).toContain('line-39') // 尾段保留
    expect(frame).toContain('行已折叠')
    expect(frame).not.toContain('line-20') // 中段被折叠
  })

  it("mode='static'：副作用全量（无折叠提示）——轮末补偿", () => {
    const { lastFrame } = render(React.createElement(ToolLine, { tool: editDone(), mode: 'static' }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('line-20') // 中段可见
    expect(frame).not.toContain('行已折叠')
  })

  it("mode='dynamic'：只读工具恒收起 ▸（bash 无自动展开）", () => {
    const { lastFrame } = render(
      React.createElement(ToolLine, { tool: bashDone(bigDiff), mode: 'dynamic' }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▸')
    expect(frame).not.toContain('▾ 输出')
    expect(frame).not.toContain('line-20') // 只见 preview 首行
  })

  it('短输出不受影响（dynamic 副作用展开无提示行）', () => {
    const { lastFrame } = render(
      React.createElement(ToolLine, {
        tool: { ...editDone(), result: { type: 'tool_result', tool_use_id: 'u1', content: '+ 新行', is_error: false } },
        mode: 'dynamic',
      }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('+ 新行')
    expect(frame).not.toContain('行已折叠')
  })
})
