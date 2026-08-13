import { describe, it, expect } from 'vitest'
import { translateOpenaiStream, toOpenaiMsgs, thinkingToOpenai } from '../../src/providers/openai.js'
import type { Message } from '../../src/core/types.js'

describe('translateOpenaiStream', () => {
  it('纯文本 → text deltas + usage + done(end)', () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]
    const deltas = translateOpenaiStream(chunks as never)
    expect(deltas).toContainEqual({ type: 'text', text: 'Hel' })
    expect(deltas).toContainEqual({ type: 'text', text: 'lo' })
    expect(deltas).toContainEqual({ type: 'usage', input_tokens: 10, output_tokens: 2 })
    expect(deltas.at(-1)).toEqual({ type: 'done', stop_reason: 'end' })
  })

  it('tool_calls → tool_use_start/delta/end + done(tool_use)', () => {
    const chunks = [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const deltas = translateOpenaiStream(chunks as never)
    expect(deltas).toContainEqual({ type: 'tool_use_start', id: 'call_1', name: 'read_file' })
    expect(deltas).toContainEqual({ type: 'tool_use_delta', id: 'call_1', partial_json: '{"path":"a.ts"}' })
    expect(deltas).toContainEqual({ type: 'tool_use_end', id: 'call_1' })
    expect(deltas.at(-1)).toEqual({ type: 'done', stop_reason: 'tool_use' })
  })

  it('finish_reason=length → done(length)', () => {
    const chunks = [{ choices: [{ delta: {}, finish_reason: 'length' }] }]
    const deltas = translateOpenaiStream(chunks as never)
    expect(deltas.at(-1)).toEqual({ type: 'done', stop_reason: 'length' })
  })

  it('多个 tool_calls（不同 index）各自 start/end', () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'ls', arguments: '' } },
                { index: 1, id: 'c2', function: { name: 'grep', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const deltas = translateOpenaiStream(chunks as never)
    expect(deltas).toContainEqual({ type: 'tool_use_start', id: 'c1', name: 'ls' })
    expect(deltas).toContainEqual({ type: 'tool_use_start', id: 'c2', name: 'grep' })
    expect(deltas).toContainEqual({ type: 'tool_use_end', id: 'c1' })
    expect(deltas).toContainEqual({ type: 'tool_use_end', id: 'c2' })
  })
})

describe('toOpenaiMsgs', () => {
  it('system 注入首条 + 文本透传', () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    const out = toOpenaiMsgs(messages, '你是助手') as Array<{ role: string; content?: string }>
    expect(out[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(out[1]).toEqual({ role: 'user', content: '你好' })
  })

  it('assistant tool_use → tool_calls', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } }] },
    ]
    const out = toOpenaiMsgs(messages, 'sys') as Array<Record<string, unknown>>
    const assistant = out[1]
    expect(assistant.role).toBe('assistant')
    const tc = assistant.tool_calls as Array<Record<string, unknown>>
    expect(tc[0].id).toBe('c1')
    expect((tc[0].function as Record<string, string>).name).toBe('read_file')
    // input → JSON 字符串
    expect(typeof (tc[0].function as Record<string, string>).arguments).toBe('string')
  })

  it('user tool_result → role:tool', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '文件内容' }] },
    ]
    const out = toOpenaiMsgs(messages, 'sys') as Array<Record<string, unknown>>
    expect(out[1].role).toBe('tool')
    expect(out[1].tool_call_id).toBe('c1')
    expect(out[1].content).toBe('文件内容')
  })
})

describe('thinkingToOpenai', () => {
  it('off / undefined → 空对象（不传）', () => {
    expect(thinkingToOpenai('off')).toEqual({})
    expect(thinkingToOpenai(undefined)).toEqual({})
  })

  it('low/medium/high → reasoning_effort', () => {
    expect(thinkingToOpenai('low')).toEqual({ reasoning_effort: 'low' })
    expect(thinkingToOpenai('medium')).toEqual({ reasoning_effort: 'medium' })
    expect(thinkingToOpenai('high')).toEqual({ reasoning_effort: 'high' })
  })
})

describe('translateOpenaiStream · flush 补发（P2-9）', () => {
  it('length 截断在 tool_call 中途 → flush 补发 tool_use_end（不丢工具）', () => {
    const out = translateOpenaiStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'ls', arguments: '' } }] } }] },
      { choices: [{ finish_reason: 'length' }] },
    ])
    expect(out.some((d) => d.type === 'tool_use_start' && d.id === 'tc1')).toBe(true)
    expect(out.some((d) => d.type === 'tool_use_end' && d.id === 'tc1')).toBe(true)
    expect(out.at(-1)?.type).toBe('done')
  })
})
