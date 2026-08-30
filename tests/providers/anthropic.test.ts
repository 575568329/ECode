import { describe, it, expect } from 'vitest'
import { translateAnthropicStream, thinkingToAnthropic, resolveMaxTokens, toAnthropicMsgs } from '../../src/providers/anthropic.js'
import type { Message } from '../../src/core/types.js'

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

  it('兼容端点：message_start 报 0/0，真值在 message_delta → usage 取 delta 的值', () => {
    // Astron/GLM 等兼容端点：message_start 的 usage 全 0，input/output/cache 真值都放 message_delta。
    // 守卫覆盖语义：delta 给了就覆盖 start 的初值。修复前这里会得到 input_tokens: 0（bug）。
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 169, output_tokens: 5, cache_read_input_tokens: 12 },
      },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'usage', input_tokens: 169, output_tokens: 5, cache_read_tokens: 12 },
      { type: 'done', stop_reason: 'end' },
    ])
  })

  it('cache 维度四维齐全：cache_read + cache_creation 都翻译', () => {
    // message_start 带 cache_creation（写 cache），message_delta 带 cache_read（读 cache）
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1, cache_creation_input_tokens: 50 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3, cache_read_input_tokens: 150 } },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'usage', input_tokens: 200, output_tokens: 3, cache_read_tokens: 150, cache_creation_tokens: 50 },
      { type: 'done', stop_reason: 'end' },
    ])
  })

  it('标准端点：message_start 给真 input，message_delta 不带 input → 保留 start 的值', () => {
    // 标准 Anthropic：input 在 message_start 给真值，message_delta 只补 output（不带 input）。
    // 守卫不通过（input == null）→ 保留 message_start 的初值，证明守卫不会误覆盖。
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]
    const deltas = translateAnthropicStream(events as never)
    expect(deltas).toEqual([
      { type: 'usage', input_tokens: 200, output_tokens: 30 },
      { type: 'done', stop_reason: 'end' },
    ])
  })
})

describe('thinkingToAnthropic', () => {
  it('off / undefined → 空对象（不传，模型默认）', () => {
    expect(thinkingToAnthropic('off')).toEqual({})
    expect(thinkingToAnthropic(undefined)).toEqual({})
  })

  it('low → enabled + budget 2048', () => {
    expect(thinkingToAnthropic('low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } })
  })

  it('medium → enabled + budget 8192', () => {
    expect(thinkingToAnthropic('medium')).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } })
  })

  it('high → enabled + budget 16384', () => {
    expect(thinkingToAnthropic('high')).toEqual({ thinking: { type: 'enabled', budget_tokens: 16384 } })
  })
})

describe('resolveMaxTokens', () => {
  it('thinking off/undefined → maxTokens 或默认 32000（2026-08-30 对标 CC/opencode）', () => {
    expect(resolveMaxTokens(undefined, 'off')).toBe(32000)
    expect(resolveMaxTokens(undefined, undefined)).toBe(32000)
    expect(resolveMaxTokens(1000, 'off')).toBe(1000)
  })

  it('thinking medium + maxTokens 8192 → clamp 到 8193（budget+1，P0-2 下限保护——显式小值仍保证合法性）', () => {
    expect(resolveMaxTokens(8192, 'medium')).toBe(8193)
    expect(resolveMaxTokens(undefined, 'medium')).toBe(32000)
  })

  it('thinking high → clamp 到 16385', () => {
    expect(resolveMaxTokens(8192, 'high')).toBe(16385)
  })

  it('maxTokens 已 > budget → 不变', () => {
    expect(resolveMaxTokens(20000, 'high')).toBe(20000)
  })
})

describe('toAnthropicMsgs · 相邻同 role 规整', () => {
  /**
   * 场景（P1）：loop recoverable/超限重试时内存 messages.pop() 但半截 assistant 已落盘，
   * /history restore 后磁盘出现两条连续 assistant——Anthropic 端点要求 role 严格交替，不合并会 400。
   */
  it('连续 assistant（半截 + 完整）→ 合并成一条，块顺序保留（前条块在前）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: [{ type: 'text', text: '半截回答' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '完整回答' },
          { type: 'tool_use', id: 't1', name: 'ls', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const out = toAnthropicMsgs(messages) as Array<{
      role: string
      content: Array<{ type: string; text?: string; id?: string }>
    }>
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    // 块顺序：半截 text → 完整 text → tool_use（前条块在前、后条块在后）
    expect(out[1].content.map((b) => b.text ?? b.id)).toEqual(['半截回答', '完整回答', 't1'])
  })

  it('连续 user（重试边界等）→ 同样合并', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '第一条' }] },
      { role: 'user', content: [{ type: 'text', text: '第二条' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ]
    const out = toAnthropicMsgs(messages) as Array<{ role: string; content: unknown[] }>
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(out[0].content).toHaveLength(2)
  })

  it('正常交替 → 不合并（透传不变）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    ]
    const out = toAnthropicMsgs(messages) as Array<{ role: string; content: unknown[] }>
    expect(out).toHaveLength(2)
  })

  it('空 content 消息 → 跳过丢弃（不产生空 content 合并残留）', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    ]
    const out = toAnthropicMsgs(messages) as Array<{ role: string; content: unknown[] }>
    expect(out).toHaveLength(2)
    expect(out[1].content).toHaveLength(1)
  })
})
