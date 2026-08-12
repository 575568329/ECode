import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Text } from 'ink'
import { Conversation, GrayStreaming } from '../../src/tui/Conversation.js'
import type { ToolCallEntry } from '../../src/tui/toolview.js'

function makeEntry(opts: { name?: string; running?: boolean; content?: string; id?: string } = {}): ToolCallEntry {
  const use = {
    type: 'tool_use' as const,
    id: opts.id ?? 'u1',
    name: opts.name ?? 'read_file',
    input: { path: 'src/x.ts' },
  }
  if (opts.running) return { use }
  return {
    use,
    result: { type: 'tool_result' as const, tool_use_id: 'u1', content: opts.content ?? 'ok', is_error: false },
  }
}

describe('GrayStreaming', () => {
  it('灰字显示流式文本', () => {
    const { lastFrame } = render(React.createElement(GrayStreaming, { text: '正在生成回答' }))
    expect(lastFrame()).toContain('正在生成回答')
  })
})

describe('Conversation', () => {
  it('streamingText 非空 → 灰字显示在动态区', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        items: [],
        streamingText: '流式内容',
        toolEntries: [],
      }),
    )
    expect(lastFrame()).toContain('流式内容')
  })

  it('streamingText 为 null → 不显示灰字', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        items: [],
        streamingText: null,
        toolEntries: [],
      }),
    )
    expect(lastFrame()).not.toContain('流式')
  })

  it('streamingText 为空串 → 不显示灰字', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        items: [],
        streamingText: '',
        toolEntries: [],
      }),
    )
    const frame = lastFrame() ?? ''
    // 空串不渲染灰字块（避免空 Text 占行）
    expect(frame.trim()).toBe('')
  })

  it('toolEntries → 渲染 ToolCallView', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        items: [],
        streamingText: null,
        toolEntries: [makeEntry({ id: 'u1', running: true }), makeEntry({ id: 'u2', name: 'bash' })],
      }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('read_file')
    expect(frame).toContain('bash')
  })

  it('items 进 Static 渲染（历史消息）', () => {
    const { lastFrame } = render(
      React.createElement(Conversation, {
        items: [
          React.createElement(Text, { key: 'u' }, '用户消息'),
          React.createElement(Text, { key: 'a' }, '助手回答'),
        ],
        streamingText: null,
        toolEntries: [],
      }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('用户消息')
    expect(frame).toContain('助手回答')
  })

  it('children 渲染在动态区（输入框占位）', () => {
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        { items: [], streamingText: null, toolEntries: [] },
        React.createElement(Text, null, '❯ 输入框'),
      ),
    )
    expect(lastFrame()).toContain('❯ 输入框')
  })

  it('组合：历史 + 流式 + 工具 + 输入 同时渲染', () => {
    const { lastFrame } = render(
      React.createElement(
        Conversation,
        {
          items: [React.createElement(Text, { key: 'h' }, '历史消息')],
          streamingText: '正在流式',
          toolEntries: [makeEntry({ running: true })],
        },
        React.createElement(Text, null, '底部输入'),
      ),
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('历史消息')
    expect(frame).toContain('正在流式')
    expect(frame).toContain('read_file')
    expect(frame).toContain('底部输入')
  })
})
