/**
 * SubagentBar 测：等待期秒数渲染（waitingSince → 「思考中 Ns」递增标签）+ 基础行。
 * 秒数换算在渲染期（本地时钟−waitingSince），组件无轮询依赖——直接断言帧文本。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { SubagentBar } from '../../src/tui/SubagentBar.js'
import type { SubagentStatus } from '../../src/services/subagent.js'

afterEach(() => cleanup())

describe('SubagentBar', () => {
  it('waitingSince 存在：显示 思考中 + 已等待秒数', () => {
    const agents: SubagentStatus[] = [
      { id: 'a1', description: '调研', activity: '思考中', waitingSince: Date.now() - 5200 },
    ]
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    const f = lastFrame() ?? ''
    expect(f).toContain('「调研」')
    // 区间断言：组合跑下构造→渲染间隔可能 >300ms，5.2s 会舍入到 6s（单跑恒 5）
    expect(f).toMatch(/思考中 [4-7]s/)
  })

  it('waitingSince 缺省（工具运行中）：只显示工具名不显示秒数', () => {
    const agents: SubagentStatus[] = [{ id: 'a2', description: '调研', activity: 'read_file' }]
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    const f = lastFrame() ?? ''
    expect(f).toContain('read_file')
    expect(f).not.toMatch(/read_file \d+s/)
  })

  it('空列表渲染 null', () => {
    const { lastFrame } = render(React.createElement(SubagentBar, { agents: [] }))
    expect(lastFrame() ?? '').toBe('')
  })
})
