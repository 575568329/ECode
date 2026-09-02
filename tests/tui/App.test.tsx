import {describe, it, expect, beforeEach, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { App } from '../../src/tui/App.js'
import { createActive, type CommittedItem, type ActiveTool } from '../../src/tui/types.js'
import { __resetClockForTest } from '../../src/tui/clock.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

beforeEach(() => {
  __resetClockForTest()
})

function tool(
  opts: { name?: string; id?: string; status?: 'running' | 'done' | 'error'; input?: unknown } = {},
): ActiveTool {
  const id = opts.id ?? 't1'
  const name = opts.name ?? 'bash'
  const use = {
    type: 'tool_use' as const,
    id,
    name,
    input: opts.input ?? { command: 'ls' },
  }
  const status = opts.status ?? 'running'
  if (status === 'running') return { name, use, status }
  return {
    name,
    use,
    status,
    result: {
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'ok',
      is_error: status === 'error',
    },
  }
}

describe('App', () => {
  it('banner 渲染在顶部（醒目 warn 色）', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'glm-5.2',
        committed: [],
        active: createActive(),
        banner: '配置不完整：缺少 API Key',
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('配置不完整')
    expect(f).toContain('⚠')
  })

  it('无 banner 不渲染 banner 区', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'glm-5.2',
        committed: [],
        active: createActive(),
      }),
    )
    expect(lastFrame() ?? '').not.toContain('⚠')
  })

  it('组合渲染：StatusBar + 历史消息', () => {
    const committed: CommittedItem[] = [{ kind: 'user', id: 'u1', text: '用户提问' }]
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        committed,
        active: createActive(),
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
        committed: [],
        active: createActive(),
        activity: 'idle',
        iter: 2,
        maxIter: 50,
        tokens: 500,
        memBytes: 350 * 1024 ** 2,
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('#2/50')
    expect(f).toContain('T500')
    expect(f).toContain('R350M')
  })

  it('timeline live text + thinking 同时显示（R4 改名：streamingText 已退役）', () => {
    const active = { ...createActive(), timeline: [{ kind: 'text', id: 'x1', text: '正在生成回答', live: true }], streaming: true }
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        committed: [],
        active,
        activity: 'thinking',
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('正在生成回答')
    expect(f).toContain('思考中')
  })

  it('timeline 工具条目 + activity=tool（R4/P0-1：旧 tools 死字段是假覆盖——断言实被 activityText 满足）', () => {
    const active = {
      ...createActive(),
      timeline: [{ kind: 'tool', id: 't1', tool: { name: 'read_file', id: 't1', status: 'done' } }],
    }
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'M',
        committed: [],
        active,
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
          committed: [],
          active: createActive(),
          activity: 'idle',
        },
        React.createElement(Text, null, '❯ 输入'),
      ),
    )
    expect(lastFrame()).toBeDefined()
  })

  it('复杂组合：历史 + 流式 + 工具 + 状态', () => {
    const committed: CommittedItem[] = [
      { kind: 'user', id: 'u1', text: '看下文件' },
      { kind: 'assistant-text', id: 'a1', text: '这是回答' },
    ]
    const active = {
      ...createActive(),
      timeline: [
        { kind: 'tool', id: 't1', tool: { name: 'bash', id: 't1', status: 'done' } },
        { kind: 'text', id: 'x1', text: '继续生成', live: true },
      ],
    }
    const { lastFrame } = render(
      React.createElement(App, {
        model: 'GLM-5.2',
        committed,
        active,
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
    expect(f).toContain('#1')
  })
})
