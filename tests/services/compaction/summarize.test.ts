import { describe, it, expect } from 'vitest'
import {
  SummarizeStrategy,
  splitMessages,
  preserveToolPairs,
  extractSummary,
} from '../../../src/services/compaction/summarize.js'
import type { Message, Delta } from '../../../src/core/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../../src/providers/interface.js'
import type { CompactionContext } from '../../../src/services/compaction/strategy.js'

const PROVIDER_REQ = { name: 'test', baseURL: 'http://x', apiKey: 'k', model: 'glm-4.6' }

/** 吐预设 Delta 序列（或抛异常）的 mock provider。 */
function mockProvider(deltas: Delta[] | Error): LLMProvider {
  return {
    type: 'mock',
    async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
      if (deltas instanceof Error) throw deltas
      for (const d of deltas) yield d
    },
  }
}

/** N 条小 text 消息（每条 4 chars = 1 token）。 */
function textMessages(n: number, text = 'aaaa'): Message[] {
  return Array.from({ length: n }, (_, i): Message => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text }],
  }))
}

/** N 条大 text 消息（每条 4000 chars = 1000 token），用于触发真实压缩（超 8000 budget）。 */
function bigTextMessages(n: number): Message[] {
  const text = 'a'.repeat(4000)
  return Array.from({ length: n }, (_, i): Message => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text }],
  }))
}

describe('splitMessages', () => {
  it('尾部累加到预算，确定 tail 起点', () => {
    expect(splitMessages(textMessages(10), 3)).toBe(7) // tail 留 3 条(7,8,9)
  })

  it('预算大于总量 → tailStart=0（全保留）', () => {
    expect(splitMessages(textMessages(5), 100)).toBe(0)
  })

  it('至少留 1 条 tail（最后一条必纳入）', () => {
    expect(splitMessages(textMessages(5), 0)).toBe(4) // 留最后 1 条
  })
})

describe('preserveToolPairs', () => {
  it('tail[0] 是孤立 tool_result（配对 use 在 head）→ 往前扩到含 use', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    expect(preserveToolPairs(msgs, 1)).toBe(0) // 扩到 0（纳入 tool_use）
  })

  it('tail[0] 是 text → 不扩', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    expect(preserveToolPairs(msgs, 1)).toBe(1)
  })

  it('tail 内已含配对 use → 不扩', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    // tailStart=0 → tail 含 use+result，全配对
    expect(preserveToolPairs(msgs, 0)).toBe(0)
  })
})

describe('extractSummary', () => {
  it('提取 <summary> 内容，strip <analysis>', () => {
    const raw = '<analysis>草稿思考</analysis>\n<summary>## 目标\n- 做X</summary>'
    expect(extractSummary(raw)).toBe('## 目标\n- 做X')
  })

  it('无 <summary> 标签 → 空串（run 会回退用 raw.trim）', () => {
    expect(extractSummary('裸文本无标签')).toBe('')
  })
})

describe('SummarizeStrategy.run', () => {
  function ctx(overrides: Partial<CompactionContext> & { provider?: LLMProvider } = {}): CompactionContext {
    return {
      messages: bigTextMessages(20), // 20000 token，超 8000 budget → 真实压缩
      tokenCount: 100000,
      effectiveWindow: 180000,
      trigger: 'pressure',
      provider: overrides.provider ?? mockProvider([
        { type: 'text', text: '<analysis>x</analysis><summary>## 目标\n- 完成 M5</summary>' },
        { type: 'done', stop_reason: 'end' },
      ]),
      providerReq: PROVIDER_REQ,
      ...overrides,
    }
  }

  it('摘要成功 → compacted:true + summary + tailStartIndex', async () => {
    const r = await new SummarizeStrategy().run(ctx())
    expect(r.compacted).toBe(true)
    expect(r.summary).toBe('## 目标\n- 完成 M5')
    expect(r.tailStartIndex).toBeGreaterThan(0)
    expect(r.preTokens).toBe(100000)
  })

  it('摘要流 error → compacted:false（降级，编排器不追加 boundary）', async () => {
    const r = await new SummarizeStrategy().run(ctx({
      provider: mockProvider([{ type: 'error', error: { code: 'X', message: 'fail', recoverable: true } }]),
    }))
    expect(r.compacted).toBe(false)
  })

  it('provider 抛异常 → compacted:false（网络降级）', async () => {
    const r = await new SummarizeStrategy().run(ctx({ provider: mockProvider(new Error('network')) }))
    expect(r.compacted).toBe(false)
  })

  it('messages 全在保留区 → compacted:false（无需压缩）', async () => {
    const r = await new SummarizeStrategy().run(ctx({
      messages: textMessages(2), // 2 token，远小于 8000 budget
      provider: mockProvider([]),
    }))
    expect(r.compacted).toBe(false)
  })

  it('滚动 summary：previousSummary → prompt 含更新指令 + 旧摘要', async () => {
    let capturedSystem = ''
    const spy: LLMProvider = {
      type: 'spy',
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        capturedSystem = req.system
        yield { type: 'text', text: '<summary>更新后的摘要</summary>' }
        yield { type: 'done', stop_reason: 'end' }
      },
    }
    await new SummarizeStrategy().run(ctx({ provider: spy, previousSummary: '旧锚定摘要内容' }))
    expect(capturedSystem).toContain('更新以下锚定摘要')
    expect(capturedSystem).toContain('旧锚定摘要内容')
  })

  it('滚动去重：previousSummary 存在时 head 剥掉投影 index-0 的旧 summaryMsg（不双重表示）', async () => {
    let capturedMessages: Message[] = []
    const spy: LLMProvider = {
      type: 'spy',
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        capturedMessages = req.messages
        yield { type: 'text', text: '<summary>更新后</summary>' }
        yield { type: 'done', stop_reason: 'end' }
      },
    }
    // 模拟投影 ctx：index-0 是 buildContextMessages 构造的旧 summaryMsg（前缀标记）
    const summaryMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: '[此前对话已压缩] 旧锚定摘要' }],
    }
    const messages = [summaryMsg, ...bigTextMessages(20)] // 21 条：投影 summaryMsg + 20 条真实消息
    await new SummarizeStrategy().run(ctx({ provider: spy, messages, previousSummary: '旧锚定摘要' }))
    // tail 留 8 条（8000 token / 1000），head 原 13 条（含 summaryMsg），剥 1 → 送摘要 12 条
    expect(capturedMessages.length).toBe(12)
    expect(capturedMessages.every((m) => !JSON.stringify(m).includes('此前对话已压缩'))).toBe(true)
  })

  it('滚动去重边界：head 只有旧 summaryMsg（无新内容）→ 不压缩（滚动摘要已涵盖）', async () => {
    const summaryMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: '[此前对话已压缩] 旧摘要' + 'x'.repeat(40000) }], // 超预算，进 head
    }
    const tail = bigTextMessages(2) // 小 tail
    const provider = mockProvider([
      { type: 'text', text: '<summary>不该被调到</summary>' },
      { type: 'done', stop_reason: 'end' },
    ])
    const r = await new SummarizeStrategy().run(
      ctx({ provider, messages: [summaryMsg, ...tail], previousSummary: '旧摘要' }),
    )
    expect(r.compacted).toBe(false) // head 剥掉 summaryMsg 后为空 → 无新内容可摘要
  })
})
