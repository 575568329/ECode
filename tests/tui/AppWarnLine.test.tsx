import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App, flattenWarnLine } from '../../src/tui/App.js'
import type { CommittedItem, ActiveState } from '../../src/tui/types.js'

describe('flattenWarnLine（告警单行化 + 截断）', () => {
  it('折叠换行/制表为空格（多行消息不破坏底部布局）', () => {
    expect(flattenWarnLine('line1\nline2\r\nline3\ttabbed', 200)).toBe('line1 line2 line3 tabbed')
  })

  it('超宽截断加省略号（429 JSON body 这类长消息）', () => {
    const long = `限流: 429 {"type":"error","error":{"type":"rate_limit_error","code":"1308","message":"${'x'.repeat(300)}"}}`
    const out = flattenWarnLine(long, 80)
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith('…')).toBe(true)
  })

  it('终端宽度未知 → 兜底 100 截断', () => {
    const out = flattenWarnLine('y'.repeat(500))
    // 默认参数走 stdout.columns ?? 100（测试环境通常 80~undefined）
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith('…')).toBe(true)
  })

  it('短消息原样保留（去首尾空白）', () => {
    expect(flattenWarnLine('  上下文将满  ', 200)).toBe('上下文将满')
  })
})

describe('App 底部告警第二行', () => {
  const emptyActive: ActiveState = {
    userInput: '',
    tools: [],
    streamingText: '',
    streaming: false,
    confirm: null,
  }

  it('warning 渲染为独立行（状态行不被挤占）', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        committed: [] as CommittedItem[],
        active: emptyActive,
        activity: 'idle',
        warning: '限流: 429 rate_limit_error（重试 1/3，等 2000ms）',
      }),
    )
    const lines = (lastFrame() ?? '').split('\n')
    const statusLine = lines.find((l) => l.includes('ECode ·'))
    const warnLine = lines.find((l) => l.includes('⚠'))
    expect(statusLine).toBeDefined()
    expect(warnLine).toBeDefined()
    // 告警不在状态行内（独立第二行），状态行仍含模型名与快捷键提示
    expect(statusLine).not.toContain('限流')
    expect(statusLine).toContain('GLM-5.2')
  })

  it('无 warning 不渲染告警行', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        committed: [] as CommittedItem[],
        active: emptyActive,
        activity: 'idle',
      }),
    )
    expect(lastFrame() ?? '').not.toContain('⚠')
  })
})
