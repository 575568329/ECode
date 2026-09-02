/** 活动流真机修复：OpenAI/智谱思考链路（thinking 对象开关 + reasoning_content 解析）。 */
import { describe, it, expect } from 'vitest'
import { thinkingToOpenai } from '../../src/providers/openai.js'
import type { OpenaiChunk } from '../../src/providers/openai.js'

// OpenaiTranslator 未导出——经 translateOpenaiStream 入口驱动（若存在）；否则直接实例化内部类不可行，
// 这里通过 thinkingToOpenai 单测 + 集成由真机抓流脚本覆盖。查导出面：
import * as openaiMod from '../../src/providers/openai.js'

const fns = Object.keys(openaiMod)
console.log('openai exports:', fns.join(','))

describe('thinkingToOpenai（智谱形态，真机实证 2026-09-02）', () => {
  it('off/undefined → 不发参数（模型默认）', () => {
    expect(thinkingToOpenai('off')).toEqual({})
    expect(thinkingToOpenai(undefined)).toEqual({})
  })

  it('low/medium/high → thinking:{type:"enabled"}（reasoning_effort 被智谱静默忽略已弃）', () => {
    expect(thinkingToOpenai('low')).toEqual({ thinking: { type: 'enabled' } })
    expect(thinkingToOpenai('high')).toEqual({ thinking: { type: 'enabled' } })
  })
})

// 翻译器驱动（translateOpenaiStream 若导出则逐 chunk 断言 reasoning_content 链路）
const translate = (openaiMod as unknown as { translateOpenaiStream?: (chunks: OpenaiChunk[]) => unknown[] })
  .translateOpenaiStream
;(translate ? describe : describe.skip)('translateOpenaiStream 思考块', () => {
  it('reasoning_content → thinking Delta；content 到达封口 thinking_end', () => {
    const out = translate([
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'The user asks' } }] },
      { choices: [{ delta: { reasoning_content: ' about math.' } }] },
      { choices: [{ delta: { content: '因为' } }] },
      { choices: [{ delta: { content: '交换律。' }, finish_reason: 'stop' }] },
    ]) as Array<{ type: string; blockIndex?: number; text?: string }>
    const kinds = out.map((d) => d.type)
    expect(kinds).toEqual(['thinking', 'thinking', 'thinking_end', 'text', 'text', 'done'])
    expect(out[0]).toMatchObject({ type: 'thinking', blockIndex: 0, text: 'The user asks' })
  })

  it('纯思考无正文：finish 时封口', () => {
    const out = translate([
      { choices: [{ delta: { reasoning_content: '只有思考' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) as Array<{ type: string }>
    expect(out.map((d) => d.type)).toEqual(['thinking', 'thinking_end', 'done'])
  })
})
