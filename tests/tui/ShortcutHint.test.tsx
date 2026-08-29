import {describe, it, expect, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { ShortcutHint } from '../../src/tui/ShortcutHint.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

describe('ShortcutHint', () => {
  // F-45（用户点名）：idle 态快捷键教学提示去除——组件在 default 上下文渲染为空
  it('default 上下文渲染为空（教学提示去除）', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, {}))
    expect((lastFrame() ?? '').trim()).toBe('')
  })

  it('busy 上下文显示中断', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, { context: 'busy' }))
    expect(lastFrame()).toContain('中断')
  })

  it('未知 context 回退 default（同样为空）', () => {
    const { lastFrame } = render(React.createElement(ShortcutHint, { context: 'unknown' }))
    expect((lastFrame() ?? '').trim()).toBe('')
  })
})
