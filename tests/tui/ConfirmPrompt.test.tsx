import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ConfirmPrompt, previewMaxLines, clampPreviewLines } from '../../src/tui/ConfirmPrompt.js'
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

  // 高度感知截断：动态区 outputHeight ≥ 视口行数触发 Ink fullscreen（视角顶到顶部、scrollback 被清），
  // 弹窗 preview 必须封顶。测试 pipe 环境 rows 未知 → 兜底 24 行 → 上限 24-12=12 行
  it('超高 diff：保头尾截断 + 省略计数，弹窗不超视口', () => {
    const lines = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? `-old${i}` : `+new${i}`))
    const diff = `--- foo.ts\n+++ foo.ts\n@@ -1,30 +1,30 @@\n${lines.join('\n')}` // 共 33 行
    const s = makeState('edit_file', { path: 'foo.ts' }, diff)
    const { lastFrame } = render(React.createElement(ConfirmPrompt, { state: s }))
    const f = lastFrame() ?? ''
    expect(f).toContain('省略')
    expect(f).toContain('--- foo.ts') // 头保留（diff 定位信息）
    expect(f).toContain('-old0')
    expect(f).toContain('+new29') // 尾保留（最近改动）
    expect(f).not.toContain('-old12') // 中间被截
  })

  it('write_file 长 content：非 diff 分支同样截断', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const s = makeState('write_file', { path: 'foo.ts' }, content)
    const { lastFrame } = render(React.createElement(ConfirmPrompt, { state: s }))
    const f = lastFrame() ?? ''
    expect(f).toContain('省略')
    expect(f).toContain('line0')
    expect(f).toContain('line29')
    expect(f).not.toContain('line15')
  })

  it('短 preview（≤ 上限）：不截断无省略提示', () => {
    const s = makeState('bash', { command: 'npm test' }, 'npm test')
    const { lastFrame } = render(React.createElement(ConfirmPrompt, { state: s }))
    expect(lastFrame() ?? '').not.toContain('省略')
  })

  it('previewMaxLines：视口感知 + 非 TTY 兜底 + 极矮保命线', () => {
    expect(previewMaxLines(undefined)).toBe(12) // 非 TTY（测试 pipe）兜底 24-12
    expect(previewMaxLines(20)).toBe(8)
    expect(previewMaxLines(50)).toBe(38)
    expect(previewMaxLines(10)).toBe(5) // 极矮终端保命线
  })

  it('clampPreviewLines：头 2/3 + 省略 + 尾 1/3；≤上限原样', () => {
    const lines = Array.from({ length: 33 }, (_, i) => `L${i}`)
    const out = clampPreviewLines(lines, 8)
    expect(out).toHaveLength(8)
    expect(out[0]).toBe('L0')
    expect(out[4]).toBe('L4') // 头 5 行（ceil(7*2/3)=5）
    expect(out[5]).toContain('省略 26 行')
    expect(out[6]).toBe('L31') // 尾 2 行
    expect(out[7]).toBe('L32')
    expect(clampPreviewLines(['a', 'b'], 8)).toEqual(['a', 'b']) // 不超原样
  })
})
