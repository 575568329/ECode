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

  it('2026-09-03 phase（busy 态）：持续过程替换主文案——thinking 显示「正在压缩对话」不显示「思考中」', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'thinking', turnStartedAt: Date.now() - 3000, phase: { text: '正在压缩对话', since: Date.now() } }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('正在压缩对话')
    expect(f).not.toContain('思考中')
    expect(f).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('2026-09-03 phase（idle 态）：空行升级为 spinner+文案+计时（compactingSince 泛化）', () => {
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'idle', phase: { text: '正在重连后台服务', since: Date.now() - 4200 } }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('正在重连后台服务')
    expect(f).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(f).toContain('4s') // 计时走 phase.since
  })

  it('phase 计时锚（审阅 P1）：busy 态 phase 期间计时走 phase.since——轮 1m 不冒充压缩 3s', () => {
    // 修复前 busy 分支 turnStartedAt 恒传轮起点：轮中自动压缩显示「正在压缩对话 · 1m0s」
    // （轮总耗时冒充压缩耗时，违背「压缩消耗多少时间」点名诉求）
    const { lastFrame } = render(
      React.createElement(ActivityBar, { state: 'thinking', turnStartedAt: Date.now() - 60_000, phase: { text: '正在压缩对话', since: Date.now() - 3000 } }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('正在压缩对话')
    expect(f).toContain('3s') // 压缩自身耗时
    expect(f).not.toContain('1m0s') // 轮总耗时不冒充
  })
})
