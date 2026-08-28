import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from 'ink-testing-library'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { renderNoticeLine } from '../../src/tui/notices.js'
import type { CommittedItem, ActiveState } from '../../src/tui/types.js'

// F-flake 卫生修复（Alt+V 破案结论同源）：遗留挂载实例 + 新实例挂载期同步/异步工作叠加
// 会让 promise 微任务渲染掉帧（lastFrame 不更新）——并行全量下偶发红。逐测卸载根治。
afterEach(() => cleanup())


describe('App 底部告警第二行', () => {
  const emptyActive: ActiveState = {
    userInput: '',
    tools: [],
    streamingText: '',
    streaming: false,
    expandedTools: new Set(),
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

describe('瞬时提示与告警中心行的优先级（useInterrupt warning 压过 notice——pty 双告警场景的渲染层锁定，审阅 P2-16）', () => {
  it('warning（双击退出提示）优先于 warningLevel 渲染（同时给时）', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        committed: [],
        active: { userInput: '', tools: [], streamingText: '', streaming: false, expandedTools: new Set(), confirm: null },
        activity: 'idle',
        warning: '再按一次 Ctrl+C 退出',
        warningLevel: 'warn',
      }),
    )
    expect(lastFrame() ?? '').toContain('再按一次 Ctrl+C 退出')
  })
})
