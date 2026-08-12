import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ToolCallView } from '../../src/tui/ToolCallView.js'
import type { ToolCallEntry } from '../../src/tui/toolview.js'

/** 构造测试用 entry */
function makeEntry(opts: {
  running?: boolean
  content?: string
  isError?: boolean
  name?: string
  input?: unknown
} = {}): ToolCallEntry {
  const use = {
    type: 'tool_use' as const,
    id: 'u1',
    name: opts.name ?? 'read_file',
    input: opts.input ?? { path: 'src/x.ts' },
  }
  if (opts.running) return { use }
  return {
    use,
    result: {
      type: 'tool_result' as const,
      tool_use_id: 'u1',
      content: opts.content ?? '',
      is_error: opts.isError,
    },
  }
}

function view(entry: ToolCallEntry, expanded?: boolean): string {
  return render(React.createElement(ToolCallView, { entry, expanded })).lastFrame() ?? ''
}

describe('ToolCallView', () => {
  it('running 态：工具名 + path，无 ✓/✗，无输出区', () => {
    const f = view(makeEntry({ running: true }))
    expect(f).toContain('read_file')
    expect(f).toContain('src/x.ts')
    expect(f).not.toContain('✓')
    expect(f).not.toContain('✗')
    expect(f).not.toContain('▸')
  })

  it('success：显示 ✓', () => {
    expect(view(makeEntry({ content: 'ok' }))).toContain('✓')
  })

  it('error：显示 ✗', () => {
    expect(view(makeEntry({ content: '失败原因', isError: true }))).toContain('✗')
  })

  it('inputDigest 显示 path', () => {
    expect(view(makeEntry({ input: { path: 'a/b.ts' }, running: true }))).toContain('a/b.ts')
  })

  it('command 入参摘要', () => {
    const f = view(makeEntry({ name: 'bash', input: { command: 'npm test' }, running: true }))
    expect(f).toContain('bash')
    expect(f).toContain('npm test')
  })

  it('长输出默认折叠（> 200B）：▸ + preview + …(NB)', () => {
    const long = 'x'.repeat(300)
    const f = view(makeEntry({ content: long }))
    expect(f).toContain('▸')
    expect(f).toContain('…')
    expect(f).toContain('300B')
  })

  it('短输出默认展开（< 200B）：▾ + 完整内容', () => {
    const f = view(makeEntry({ content: 'short output' }))
    expect(f).toContain('▾')
    expect(f).toContain('short output')
  })

  it('expanded=true 强制展开长输出', () => {
    const long = 'y'.repeat(300)
    const f = view(makeEntry({ content: long }), true)
    expect(f).toContain('▾')
    expect(f).not.toContain('▸')
    // 长内容按终端宽度折行，验证首段存在即可（非连续 300 字符）
    expect(f).toContain('yyyyy')
  })

  it('expanded=false 强制折叠短输出', () => {
    expect(view(makeEntry({ content: 'short' }), false)).toContain('▸')
  })

  it('空输出不显示折叠区', () => {
    const f = view(makeEntry({ content: '' }))
    expect(f).not.toContain('▸')
    expect(f).not.toContain('▾')
  })

  it('KB 级输出格式化', () => {
    const f = view(makeEntry({ content: 'a'.repeat(1500) }))
    expect(f).toContain('KB')
  })
})
