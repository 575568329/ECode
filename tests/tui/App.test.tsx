import { describe, it, expect, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { App } from '../../src/tui/App.js'
import { UserMessage } from '../../src/tui/UserMessage.js'
import { AssistantMessage } from '../../src/tui/AssistantMessage.js'
import { __resetClockForTest } from '../../src/tui/clock.js'

beforeEach(() => {
  __resetClockForTest()
})

describe('App', () => {
  it('组合渲染：StatusBar + 历史消息', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        items: [React.createElement(UserMessage, { key: 'u', text: '用户提问' })],
        streamingText: null,
        toolEntries: [],
        activity: 'idle',
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('GLM-5.2')
    expect(f).toContain('用户提问')
  })

  it('StatusBar 元信息透传', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        items: [],
        streamingText: null,
        toolEntries: [],
        activity: 'idle',
        iter: 2,
        maxIter: 50,
        tokens: 500,
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('轮 2/50')
    expect(f).toContain('500 tok')
  })

  it('streaming + thinking 同时显示', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        items: [],
        streamingText: '正在生成回答',
        toolEntries: [],
        activity: 'thinking',
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('正在生成回答')
    expect(f).toContain('思考中')
  })

  it('工具调用 + activity=tool', () => {
    const entry = {
      use: { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    }
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        items: [],
        streamingText: null,
        toolEntries: [entry],
        activity: 'tool',
        activityText: 'read_file',
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('read_file')
  })

  it('children 渲染（输入区占位）', () => {
    const { lastFrame } = render(
      React.createElement(
        App,
        {
          model: 'M',
          items: [],
          streamingText: null,
          toolEntries: [],
          activity: 'idle',
        },
        React.createElement(Text, null, '❯ 输入'),
      ),
    )
    // children 渲染在动态区底部（具体内容由第 4 步 InputStream 提供）
    // 此处仅验证 App 不因 children 崩溃
    expect(lastFrame()).toBeDefined()
  })

  it('复杂组合：历史 + 流式 + 工具 + 状态', () => {
    const entry = {
      use: { type: 'tool_use' as const, id: 't1', name: 'bash', input: { command: 'ls' } },
      result: { type: 'tool_result' as const, tool_use_id: 't1', content: 'file.ts', is_error: false },
    }
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        items: [
          React.createElement(UserMessage, { key: 'u', text: '看下文件' }),
          React.createElement(AssistantMessage, { key: 'a', text: '这是回答' }),
        ],
        streamingText: '继续生成',
        toolEntries: [entry],
        activity: 'tool',
        activityText: 'bash',
        iter: 1,
        tokens: 300,
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('看下文件')
    expect(f).toContain('这是回答')
    expect(f).toContain('继续生成')
    expect(f).toContain('bash')
    expect(f).toContain('轮 1')
  })
})
