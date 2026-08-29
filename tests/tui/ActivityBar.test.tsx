import {describe, it, expect, beforeEach, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { ActivityBar } from '../../src/tui/ActivityBar.js'
import { __resetClockForTest } from '../../src/tui/clock.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

beforeEach(() => {
  __resetClockForTest()
})

describe('ActivityBar', () => {
  it('thinking：spinner + 思考中', () => {
    const { lastFrame } = render(React.createElement(ActivityBar, { state: 'thinking' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('思考中')
    // spinner 是 braille 帧
    expect(f).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('tool：显示工具名', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'tool', text: 'read_file' }),
    )
    expect(lastFrame()).toContain('read_file')
  })

  it('tool：无 text 时显示「执行中」', () => {
    const { lastFrame } = render(React.createElement(ActivityBar, { state: 'tool' }))
    expect(lastFrame()).toContain('执行中')
  })

  it('retry：显示重试中', () => {
    const { lastFrame } = render(React.createElement(ActivityBar, { state: 'retry' }))
    expect(lastFrame()).toContain('重试中')
  })

  it('aborted：不显示黄字横幅（F-38——中断提示收敛到底部告警行，此处空占位防布局跳动）', () => {
    const { lastFrame } = render(React.createElement(ActivityBar, { state: 'aborted' }))
    const f = lastFrame() ?? ''
    expect(f).not.toContain('已中断')
    expect(f).not.toContain('内容已保留')
    expect(f).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('idle：占位（无 spinner / 无文案）', () => {
    const { lastFrame } = render(React.createElement(ActivityBar, { state: 'idle' }))
    const f = lastFrame() ?? ''
    expect(f).not.toContain('思考中')
    expect(f).not.toContain('执行中')
    expect(f).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })
})
