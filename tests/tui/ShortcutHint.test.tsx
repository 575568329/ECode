import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ShortcutHint } from '../../src/tui/ShortcutHint.js'

describe('ShortcutHint', () => {
  it('default 上下文显示发送/命令/历史', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, {}))
    const f = lastFrame() ?? ''
    expect(f).toContain('发送')
    expect(f).toContain('命令')
    expect(f).toContain('历史')
  })

  it('busy 上下文显示中断', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, { context: 'busy' }))
    expect(lastFrame()).toContain('中断')
  })

  it('未知 context 回退 default', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, { context: 'unknown' }))
    expect(lastFrame()).toContain('发送')
  })
})
