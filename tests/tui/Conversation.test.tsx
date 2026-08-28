import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { Conversation, GrayStreaming } from '../../src/tui/Conversation.js'
import { createActive, type CommittedItem, type ActiveTool } from '../../src/tui/types.js'

describe('GrayStreaming', () => {
  it('灰字显示流式文本', () => {
    const { lastFrame } = render(React.createElement(GrayStreaming, { text: '正在生成回答' }))
    expect(lastFrame()).toContain('正在生成回答')
  })

  it('短文本（≤3 行）不折叠', () => {
    const { lastFrame } = render(React.createElement(GrayStreaming, { text: 'a\nb\nc' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('a')
    expect(f).toContain('c')
    expect(f).not.toContain('折叠')
  })

  it('长文本（>3 行）折叠头部 + 顶部提示', () => {
    const text = '第1行\n第2行\n第3行\n第4行\n第5行\n第6行\n第7行\n第8行'
    const { lastFrame } = render(React.createElement(GrayStreaming, { text }))
    const f = lastFrame() ?? ''
    expect(f).toContain('折叠')
    expect(f).toContain('共 8 行')
    // 尾部 3 行显示
    expect(f).toContain('第6行')
    expect(f).toContain('第8行')
    // 头部 5 行被折叠
    expect(f).not.toContain('第1行')
    expect(f).not.toContain('第5行')
  })
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

describe('Conversation', () => {
  it('active.streamingText + streaming=true → 灰字（GrayStreaming）', () => {
    const active = { ...createActive(), streamingText: '流式内容', streaming: true }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('流式内容')
  })

  it('active.streamingText + streaming=false → Markdown（流式结束，当前轮保留动态区可展开）', () => {
    const active = { ...createActive(), streamingText: '完成的回答', streaming: false }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('完成的回答')
  })

  it('active 全空 → 动态区无灰字', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, { committed: [], active: createActive() }),
    )
    expect(lastFrame() ?? '').not.toContain('流式')
  })

  it('active.tools → 渲染 ToolGroupView（合并块）', () => {
    const active = {
      ...createActive(),
      tools: [tool({ id: 't1', name: 'read_file' }), tool({ id: 't2', name: 'bash' })],
    }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    const f = lastFrame() ?? ''
    // 审阅批4：allocateDynamic 输入区实占 8 行后 24 行窗 toolGroupCap=1——第 2 组折叠为提示行
    expect(f).toContain('1 个工具')
    expect(f).toContain('read_file')
    expect(f).toContain('还有 1 个工具因终端预算折叠')
  })

  it('active.userInput → 显示用户消息', () => {
    const active = { ...createActive(), userInput: '帮我写代码' }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    expect(lastFrame()).toContain('帮我写代码')
  })

  it('committed 进 Static 渲染（历史消息）', () => {
    const committed: CommittedItem[] = [
      { kind: 'user', id: 'u1', text: '历史用户' },
      { kind: 'assistant-text', id: 'a1', text: '历史回答' },
    ]
    const { lastFrame } = render(
      React.createElement(Conversation, { committed, active: createActive() }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('历史用户')
    expect(f).toContain('历史回答')
  })

  it('children 渲染在动态区', () => {
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        { committed: [], active: createActive() },
        React.createElement(Text, null, '❯ 输入框'),
      ),
    )
    expect(lastFrame()).toContain('❯ 输入框')
  })

  it('组合：历史 + 流式 + 工具 + 输入', () => {
    const committed: CommittedItem[] = [{ kind: 'user', id: 'u1', text: '历史消息' }]
    const active = {
      ...createActive(),
      streamingText: '正在流式',
      tools: [tool({ id: 't1', name: 'read_file' })],
    }
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        { committed, active },
        React.createElement(Text, null, '底部输入'),
      ),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('历史消息')
    expect(f).toContain('正在流式')
    expect(f).toContain('1 个工具')
    expect(f).toContain('底部输入')
  })

  it('userInput 超过 2 行 → 折叠（P1-A）', () => {
    const active = { ...createActive(), userInput: '行1\n行2\n行3\n行4\n行5' }
    const { lastFrame } = render(React.createElement(Conversation, { committed: [], active }))
    const f = lastFrame() ?? ''
    expect(f).toContain('折叠')
    expect(f).toContain('共 5 行')
    expect(f).toContain('行4')
    expect(f).toContain('行5')
    expect(f).not.toContain('行1')
  })
})
