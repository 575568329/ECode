/**
 * SubagentBar 测（2026-09-03 拍板批）：折叠行只显示总时长（startedAt 起算 m:ss）——
 * 阶段耗时（waitingSince）不进折叠行，transcript 展开的事件行时刻承担。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { SubagentBar, formatDuration } from '../../src/tui/SubagentBar.js'
import type { SubagentStatus } from '../../src/services/subagent.js'

afterEach(() => cleanup())

describe('formatDuration（总时长 m:ss / h:mm:ss）', () => {
  it('0-59s 秒段；60s+ m:ss；1h+ h:mm:ss；负数钳 0', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(59)).toBe('0:59')
    expect(formatDuration(172)).toBe('2:52')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(-3)).toBe('0:00')
  })
})

describe('SubagentBar 总时长显示（2026-09-03）', () => {
  it('行内显示 startedAt 起的总时长（不再是 waitingSince 阶段秒数）', () => {
    const now = Date.now()
    const agents: SubagentStatus[] = [
      { id: 'a-1', description: '架构审阅', activity: '思考中', startedAt: now - 172_000, waitingSince: now - 5_000 },
    ]
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('「架构审阅」')
    expect(frame).toContain('思考中')
    expect(frame).toContain('2:52') // 172s 总时长（旧实现显示 5s 阶段秒数）
    expect(frame).not.toMatch(/思考中 \d+s/) // 阶段秒数形态不再出现
  })

  it('无 startedAt（旧宿主帧兼容）：退化为无时长段——不显示 0:00 假值', () => {
    const agents: SubagentStatus[] = [{ id: 'a-2', description: '旧任务', activity: '启动中' }]
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    expect(lastFrame()).toContain('「旧任务」')
    expect(lastFrame() ?? '').not.toContain('0:00')
  })

  it('超 3 个折叠为合计行 + 最久总时长（names 顶满时整行截断恒 1 物理行）', () => {
    const now = Date.now()
    const agents: SubagentStatus[] = Array.from({ length: 4 }, (_, i) => ({
      id: `a-${i}`,
      description: `任务${i}`,
      activity: '思考中',
      startedAt: now - (60 + i * 60) * 1000,
    }))
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('4 个子代理运行中')
    expect(frame).toContain('最久 4:00')
    // 审阅修复批（功能席 P1-2）：names 与尾段并入同一 clipWidth——超长描述不折行
    const longAgents: SubagentStatus[] = Array.from({ length: 4 }, (_, i) => ({
      id: `b-${i}`,
      description: '这是一个非常非常长的子代理任务描述用于撑满整行验证截断行为不换行'.repeat(6),
      activity: '思考中',
      startedAt: now - 60_000,
    }))
    const long = render(React.createElement(SubagentBar, { agents: longAgents }))
    const lines = (long.lastFrame() ?? '').split('\n').filter((l) => l.includes('个子代理运行中'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.length).toBeLessThanOrEqual((process.stdout.columns ?? 80) + 4)
  })

  it('折叠行 startedAt 全缺（旧 daemon 帧混跑）：不显示「最久 0:00」假值', () => {
    const agents: SubagentStatus[] = Array.from({ length: 4 }, (_, i) => ({
      id: `c-${i}`,
      description: `旧任务${i}`,
      activity: '思考中',
    }))
    const { lastFrame } = render(React.createElement(SubagentBar, { agents }))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('4 个子代理运行中')
    expect(frame).not.toContain('最久')
  })

  it('空列表渲染 null', () => {
    const { lastFrame } = render(React.createElement(SubagentBar, { agents: [] }))
    expect(lastFrame() ?? '').toBe('')
  })
})
