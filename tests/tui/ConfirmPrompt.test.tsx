import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ConfirmPrompt } from '../../src/tui/ConfirmPrompt.js'
import type { ConfirmState } from '../../src/tui/types.js'
import type { ToolUseBlock } from '../../src/core/types.js'

function makeState(name: string, input: Record<string, unknown>, preview: string): ConfirmState {
  return {
    use: { type: 'tool_use', id: 't1', name, input } as ToolUseBlock,
    preview,
    resolve: () => {},
  }
}

describe('ConfirmPrompt', () => {
  it('bash：显示命令 + y/n', () => {
    const s = makeState('bash', { command: 'npm test' }, 'npm test')
    const { lastFrame } = render(React.createElement(ConfirmPrompt, { state: s }))
    const f = lastFrame() ?? ''
    expect(f).toContain('⚠ 执行 bash?')
    expect(f).toContain('npm test')
    expect(f).toContain('[y]')
    expect(f).toContain('[n]')
  })

  it('edit_file：显示路径 + diff（-old / +new）', () => {
    const diff = '--- foo.ts\n+++ foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new'
    const s = makeState('edit_file', { path: 'foo.ts' }, diff)
    const { lastFrame } = render(React.createElement(ConfirmPrompt, { state: s }))
    const f = lastFrame() ?? ''
    expect(f).toContain('⚠ 执行 edit_file?')
    expect(f).toContain('foo.ts')
    expect(f).toContain('-old')
    expect(f).toContain('+new')
  })

  it('y → resolve(true) + onConfirm', () => {
    let resolved: boolean | null = null
    let cleared = false
    const s = makeState('bash', { command: 'x' }, 'x')
    s.resolve = (ok) => {
      resolved = ok
    }
    const { stdin } = render(
      React.createElement(ConfirmPrompt, { state: s, onConfirm: () => {
        cleared = true
      } }),
    )
    stdin.write('y')
    expect(resolved).toBe(true)
    expect(cleared).toBe(true)
  })

  it('n → resolve(false) + onCancel', () => {
    let resolved: boolean | null = null
    let cleared = false
    const s = makeState('bash', { command: 'x' }, 'x')
    s.resolve = (ok) => {
      resolved = ok
    }
    const { stdin } = render(
      React.createElement(ConfirmPrompt, { state: s, onCancel: () => {
        cleared = true
      } }),
    )
    stdin.write('n')
    expect(resolved).toBe(false)
    expect(cleared).toBe(true)
  })

  it('回车（默认选中 y）→ resolve(true)', () => {
    let resolved: boolean | null = null
    const s = makeState('bash', { command: 'x' }, 'x')
    s.resolve = (ok) => {
      resolved = ok
    }
    const { stdin } = render(
      React.createElement(ConfirmPrompt, { state: s, onConfirm: () => {} }),
    )
    stdin.write('\r')
    expect(resolved).toBe(true)
  })
})
