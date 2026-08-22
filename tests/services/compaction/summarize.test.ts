import { describe, it, expect } from 'vitest'
import {
  SummarizeStrategy,
  splitMessages,
  preserveToolPairs,
  extractSummary,
  serializeMessage,
  groupBatches,
  splitTextHalf,
  batchBudgetTokens,
  TOOL_RESULT_MAX_CHARS,
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

  it('M12-P0：摘要流含 usage → ctx.onUsage 收到四维（压缩漏账修复）', async () => {
    const calls: Array<[number, number, { read?: number; creation?: number } | undefined]> = []
    const r = await new SummarizeStrategy().run(ctx({
      provider: mockProvider([
        { type: 'text', text: '<summary>x</summary>' },
        { type: 'usage', input_tokens: 3000, output_tokens: 200, cache_read_tokens: 500, cache_creation_tokens: 100 },
        { type: 'done', stop_reason: 'end' },
      ]),
      onUsage: (i, o, c) => {
        calls.push([i, o, c])
      },
    }))
    expect(r.compacted).toBe(true)
    expect(calls).toEqual([[3000, 200, { read: 500, creation: 100 }]])
  })

  it('M12-P0：未传 onUsage → 不报也不炸（向下兼容）', async () => {
    const r = await new SummarizeStrategy().run(ctx({
      provider: mockProvider([
        { type: 'text', text: '<summary>x</summary>' },
        { type: 'usage', input_tokens: 10, output_tokens: 5 },
        { type: 'done', stop_reason: 'end' },
      ]),
    }))
    expect(r.compacted).toBe(true)
  })

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

describe('分批路径（v2：超大 head 的 map-reduce）', () => {
  /** 可编程 mock：按调用序返回预设（Delta[] 或 throw），并记录每次请求。 */
  function seqProvider(
    steps: Array<Delta[] | Error>,
  ): LLMProvider & { calls: LLMProviderRunRequest[] } {
    const calls: LLMProviderRunRequest[] = []
    let i = 0
    return {
      type: 'seq',
      calls,
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        calls.push(req)
        const step = steps[Math.min(i++, steps.length - 1)]
        if (step instanceof Error) throw step
        for (const d of step) yield d
      },
    }
  }

  const ok = (text: string): Delta[] => [
    { type: 'text', text: `<summary>${text}</summary>` },
    { type: 'done', stop_reason: 'end' },
  ]

  /** 分批用例的 ctx 构造（SummarizeStrategy.run 的 ctx helper 在别的 describe 块内，这里独立一份）。 */
  function mkCtx(overrides: Partial<CompactionContext> & { provider: LLMProvider }): CompactionContext {
    return {
      messages: bigTextMessages(30),
      tokenCount: 600000,
      effectiveWindow: 30000,
      trigger: 'manual',
      providerReq: PROVIDER_REQ,
      ...overrides,
    }
  }

  it('serializeMessage：text/tool_use/tool_result 各形态 + 超长 tool result 截断', () => {
    const m: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来看下' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(TOOL_RESULT_MAX_CHARS + 5000), is_error: true },
      ],
    }
    const s = serializeMessage(m)
    expect(s).toContain('[Assistant]: 我来看下')
    expect(s).toContain('[Assistant tool call]: bash({"cmd":"ls"})')
    expect(s).toContain('[Tool error]:')
    expect(s).toContain(`原文 ${TOOL_RESULT_MAX_CHARS + 5000} 字符`)
    expect(s.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 500) // 确实截断了
  })

  it('groupBatches：按字节预算组批 + 超大单块截断独立成批', () => {
    const blocks = ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000), 'h'.repeat(9000)]
    const batches = groupBatches(blocks, 8100)
    // 前两块 4000+2+4000=8002 ≤ 8100 同批；第三块触发新批；9000 > 8100 截断独立成批
    expect(batches.length).toBe(3)
    expect(batches[0]).toContain('aaaa')
    expect(batches[0]).toContain('bbbb')
    expect(batches[2]).toContain('原文 9000 字符')
  })

  it('splitTextHalf：优先换行边界；附近无换行则腰斩', () => {
    const [a, b] = splitTextHalf('line1\nline2\nline3\nline4')
    expect(a).toBe('line1\nline2') // 中点附近换行处切
    expect(b).toBe('\nline3\nline4')
    const [x, y] = splitTextHalf('abcdefgh') // 无换行
    expect(x).toBe('abcd')
    expect(y).toBe('efgh')
  })

  it('batchBudgetTokens：减法公式（窗口−输出−buffer−system）+ 下限钳', () => {
    expect(batchBudgetTokens(180000)).toBe(180000 - 4096 - 8000 - 1500)
    expect(batchBudgetTokens(10000)).toBe(20000) // 钳下限，避免窗口小退化成几十批
  })

  it('head 超批预算 → 分批 map×2 + reduce×1，批首含作用域声明', async () => {
    // effectiveWindow=30000 → budget=16404 token；30 条×1000 token → tail 8 条、head 22 条=22000 > 16404 → 分 2 批
    const provider = seqProvider([ok('段1'), ok('段2'), ok('## 目标\n- 最终')])
    const r = await new SummarizeStrategy().run(mkCtx({ provider }))
    expect(r.compacted).toBe(true)
    expect(r.summary).toBe('## 目标\n- 最终')
    expect(r.tailStartIndex).toBe(22)
    expect(provider.calls.length).toBe(3) // 2 map + 1 reduce
    const batch1Text = (provider.calls[0].messages[0].content[0] as { text: string }).text
    expect(batch1Text).toContain('第 1/2 段') // 作用域声明
    expect(batch1Text).toContain('不要写总结性结尾')
    const reduceText = (provider.calls[2].messages[0].content[0] as { text: string }).text
    expect(reduceText).toContain('【第 1 段（时序）】') // reduce 输入是分段摘要
  })

  it('批 400（CONTEXT_TOO_LONG）→ 二分重试后成功（不丢内容）', async () => {
    const ctl = Object.assign(new Error('prompt is too long: 90000 > 65616'), { status: 400 })
    const provider = seqProvider([
      ctl, // 批1 第一次：400 → 二分
      ok('批1前半'), // 批1 前半
      ok('批1后半'), // 批1 后半
      ok('段2'), // 批2
      ok('final'), // reduce
    ])
    const r = await new SummarizeStrategy().run(mkCtx({ provider }))
    expect(r.compacted).toBe(true)
    expect(r.summary).toBe('final')
    expect(provider.calls.length).toBe(5) // 1失败 + 2半批 + 1批2 + 1 reduce
  })

  it('非 context-too-long 错误 → 不二分，整次降级 compacted:false', async () => {
    const provider = seqProvider([new Error('network down')])
    const r = await new SummarizeStrategy().run(mkCtx({ provider }))
    expect(r.compacted).toBe(false)
    // 并行 map：两批同时发起（2 次调用），失败的那批不二分不重试
    expect(provider.calls.length).toBe(2)
  })
})
