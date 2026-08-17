/** 多模态双协议翻译测（M10-P0）：anthropic blocks 组数组/透传剥元信息；openai image_url 转移。 */
import { describe, expect, it } from 'vitest'
import { toAnthropicMsgs } from '../../src/providers/anthropic.js'
import { toOpenaiMsgs } from '../../src/providers/openai.js'
import type { Message, ToolResultBlock, ImageBlock, DocumentBlock } from '../../src/core/types.js'

const img = (data = 'AAA'): ImageBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
  _w: 100,
  _h: 200,
})
const doc: DocumentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } }

const tr = (blocks?: Array<ImageBlock | DocumentBlock>): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: 't1',
  content: '已读取图片 a.png（内容见附图）',
  ...(blocks !== undefined ? { blocks } : {}),
})

describe('toAnthropicMsgs（多模态）', () => {
  it('tool_result 带 blocks → content 组数组（text + image，元信息 _w/_h 剥除）', () => {
    const msgs: Message[] = [{ role: 'user', content: [tr([img()])] }]
    const out = toAnthropicMsgs(msgs) as Array<{ content: Array<Record<string, unknown>> }>
    const block = out[0]!.content[0]! as Record<string, unknown>
    expect(block.type).toBe('tool_result')
    const content = block.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: '已读取图片 a.png（内容见附图）' })
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } })
    expect(JSON.stringify(content[1])).not.toContain('_w')
  })
  it('user 消息原生 image/document 透传剥元信息；无 blocks 的 tool_result 保持原样', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: '看图' }, img('XYZ'), doc] }]
    const out = toAnthropicMsgs(msgs) as Array<{ content: Array<Record<string, unknown>> }>
    expect(out[0]!.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'XYZ' } })
    expect(out[0]!.content[2]).toEqual(doc)
    const plain = toAnthropicMsgs([{ role: 'user', content: [tr()] }]) as Array<{ content: ToolResultBlock[] }>
    expect(typeof plain[0]!.content[0]!.content).toBe('string')
  })
})

describe('toOpenaiMsgs（多模态）', () => {
  it('tool_result 的 image 转移至紧随 user 消息（image_url data URI）；tool 消息只留文本', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [tr([img()])] },
    ]
    const out = toOpenaiMsgs(msgs, 'sys') as Array<Record<string, unknown>>
    const toolMsg = out.find((m) => m.role === 'tool') as { content: string }
    expect(toolMsg.content).toBe('已读取图片 a.png（内容见附图）') // tool 消息无图
    const userMsg = out.find((m) => m.role === 'user' && typeof m.content === 'object') as { content: Array<Record<string, unknown>> }
    const parts = userMsg.content
    expect(parts.some((p) => p.type === 'image_url' && (p.image_url as { url: string }).url === 'data:image/png;base64,AAA')).toBe(true)
    expect(parts.some((p) => p.type === 'text')).toBe(true)
  })
  it('user 原生 image → parts 数组；纯文本 user 仍 string（兼容端点）', () => {
    const mixed = toOpenaiMsgs([{ role: 'user', content: [{ type: 'text', text: '看' }, img('Q==')] }], 's') as Array<Record<string, unknown>>
    const m = mixed.find((x) => x.role === 'user')!
    expect(typeof m.content).toBe('object')
    const text = toOpenaiMsgs([{ role: 'user', content: [{ type: 'text', text: '你好' }] }], 's') as Array<Record<string, unknown>>
    expect(typeof text.find((x) => x.role === 'user')!.content).toBe('string')
  })
  it('document 不转移：纯 document 消息给占位文本', () => {
    const out = toOpenaiMsgs([{ role: 'user', content: [doc] }], 's') as Array<Record<string, unknown>>
    const m = out.find((x) => x.role === 'user')!
    expect(m.content).toContain('不支持 document')
  })
})
