import { describe, it, expect } from 'vitest'
import { translateAnthropicStream } from '../../src/providers/anthropic.js'

/**
 * translateAnthropicStream：把 Anthropic 协议事件序列翻译成统一 Delta 序列。
 * 输入用 plain 对象（鸭子类型，按 Anthropic 协议结构），不硬依赖 SDK 内部类型。
 */
describe('translateAnthropicStream', () => {
  it('纯文本回复 → text deltas + usage + done(end)', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'usage', input_tokens: 10, output_tokens: 2 },
      { type: 'done', stop_reason: 'end' },
    ])
  })

  it('工具调用 → tool_use_start/delta/end + done(tool_use)', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'tool_use_start', id: 't1', name: 'read_file' },
      { type: 'tool_use_delta', id: 't1', partial_json: '{"path":"a.ts"}' },
      { type: 'tool_use_end', id: 't1' },
      { type: 'usage', input_tokens: 5, output_tokens: 8 },
      { type: 'done', stop_reason: 'tool_use' },
    ])
  })

  it('stop_reason 映射：max_tokens → length', () => {
    const events = [
      { type: 'message_start', message: {} },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas.at(-1)).toEqual({ type: 'done', stop_reason: 'length' })
  })

  it('stop_reason 映射：end_turn → end', () => {
    const events = [
      { type: 'message_start', message: {} },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas.at(-1)).toEqual({ type: 'done', stop_reason: 'end' })
  })

  it('error 事件 → Delta error', () => {
    const events = [
      { type: 'message_start', message: {} },
      { type: 'error', error: { type: 'overloaded_error', message: 'stream broke' } },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas.some((d) => d.type === 'error')).toBe(true)
  })

  it('多个 content block（text + tool_use 混合）按 index 区分', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '查一下' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't9', name: 'read_file', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'text', text: '查一下' },
      { type: 'tool_use_start', id: 't9', name: 'read_file' },
      { type: 'tool_use_delta', id: 't9', partial_json: '{}' },
      { type: 'tool_use_end', id: 't9' },
      { type: 'usage', input_tokens: 3, output_tokens: 6 },
      { type: 'done', stop_reason: 'tool_use' },
    ])
  })
})
