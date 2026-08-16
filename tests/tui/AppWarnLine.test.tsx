import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { renderNoticeLine } from '../../src/tui/notices.js'
import type { CommittedItem, ActiveState } from '../../src/tui/types.js'


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
        warning: renderNoticeLine({ level: 'warn', text: '限流: 429 rate_limit_error（重试 1/3，等 2000ms）', rest: 0 }, 100),
        warningLevel: 'warn',
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
