import { describe, it, expect, vi } from 'vitest'
import { runLoop, type LoopRunOptions } from '../../src/core/loop.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, HistoryLine, Message } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'

/** MockProvider：按脚本逐轮吐预设 Delta 序列（不发网络）。 */
class MockProvider implements LLMProvider {
  readonly type = 'mock'
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const sig = () => new AbortController().signal

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function makeOpts(provider: LLMProvider, tools: Tool[]): LoopRunOptions {
  const reg = new ToolRegistryImpl()
  for (const t of tools) reg.register(t)
  return {
    provider,
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    callbacks: { onText: vi.fn(), onWarn: vi.fn() },
    providerReq: { name: 'test', baseURL: 'http://x', apiKey: 'sk', model: 'm' },
    system: 'sys',
    maxIterations: 10,
    toolCtx: { cwd: process.cwd(), signal: sig() },
  }
}

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  readonly: true,
  async execute(args) {
    return { content: (args as { msg: string }).msg }
  },
}

const last = (m: Message[]) => m.at(-1)!.content[0] as Record<string, unknown>

describe('runLoop：afterTools（M9-P3 轮末质量回喂）', () => {
  const writeTool: Tool = {
    name: 'write_file',
    description: 'write',
    input_schema: { type: 'object', properties: {}, required: [] },
    readonly: false,
    async execute() {
      return { content: 'ok' }
    },
  }

  it('编辑轮后回调收到工具清单；feedback 追加为 user 消息', async () => {
    const afterTools = vi.fn(async () => ({ feedback: '[lint] 1 error' }))
    const p = new MockProvider([
      [{ type: 'tool_use_start', id: 't1', name: 'write_file' }, { type: 'tool_use_end', id: 't1' }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text', text: 'fixed' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = { ...makeOpts(p, [writeTool]), afterTools }
    const messages = await runLoop([], 'fix it', opts)
    expect(afterTools).toHaveBeenCalledWith({ tools: [{ name: 'write_file', isError: false }] })
    // messages：user 输入 / assistant tool_use / user tool_result / user feedback / assistant text
    const fb = messages[3]
    expect(fb.role).toBe('user')
    expect((fb.content[0] as { text?: string }).text).toContain('[lint] 1 error')
    expect(messages).toHaveLength(5)
  })

  it('终审 P1-1：工具混排（副作用在前+只读在后）时 isError 按 id 正确配对', async () => {
    // write_file 失败（is_error）+ 只读工具成功——executeTools 重排 [readonlys..., sideEffects...]，
    // 按位置配对会把 read 的成功错配给 write_file → QualityGate 误判"编辑成功"
    const failingWrite: Tool = {
      name: 'write_file',
      description: 'w',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: false,
      async execute() {
        return { content: '写失败', is_error: true }
      },
    }
    const okRead: Tool = {
      name: 'read_file',
      description: 'r',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        return { content: '内容' }
      },
    }
    const afterTools = vi.fn(async () => undefined)
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 'w1', name: 'write_file' },
        { type: 'tool_use_end', id: 'w1' },
        { type: 'tool_use_start', id: 'r1', name: 'read_file' },
        { type: 'tool_use_end', id: 'r1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = { ...makeOpts(p, [failingWrite, okRead]), afterTools }
    await runLoop([], 'go', opts)
    expect(afterTools).toHaveBeenCalledWith({
      tools: [
        { name: 'write_file', isError: true },
        { name: 'read_file', isError: false },
      ],
    })
  })

  it('无 feedback（全绿/未配置）→ 不追加消息', async () => {
    const afterTools = vi.fn(async () => undefined)
    const p = new MockProvider([
      [{ type: 'tool_use_start', id: 't1', name: 'write_file' }, { type: 'tool_use_end', id: 't1' }, { type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = { ...makeOpts(p, [writeTool]), afterTools }
    const messages = await runLoop([], 'go', opts)
    expect(afterTools).toHaveBeenCalled()
    expect(messages).toHaveLength(4) // 无 feedback 消息
  })
})

describe('runLoop', () => {
  it('纯文本回复 → user + assistant，onText 收到增量', async () => {
    const onText = vi.fn()
    const p = new MockProvider([[{ type: 'text', text: 'hi' }, { type: 'done', stop_reason: 'end' }]])
    const opts = { ...makeOpts(p, []), callbacks: { onText, onWarn: vi.fn() } }
    const messages = await runLoop([], 'hello', opts)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    expect(onText).toHaveBeenCalledWith('hi')
  })

  it('工具调用 → tool_use + tool_result 回流 + 最终回复', async () => {
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_delta', id: 't1', partial_json: '{"msg":"hi"}' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, [echoTool]))
    expect(messages).toHaveLength(4)
    expect(messages[1].content[0]).toMatchObject({ type: 'tool_use', name: 'echo' })
    expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'hi' })
    expect(messages[3].content[0]).toMatchObject({ type: 'text', text: 'done' })
  })

  it('工具不存在 → is_error 的 tool_result（不崩 Loop）', async () => {
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'nope' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, []))
    expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', is_error: true })
  })

  it('AJV 校验失败 → is_error（根本不进 Tool）', async () => {
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_delta', id: 't1', partial_json: '{}' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, [echoTool]))
    expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', is_error: true })
  })

  it('recoverable 错误 → onWarn + 继续下一轮', async () => {
    const onWarn = vi.fn()
    const p = new MockProvider([
      [{ type: 'error', error: { code: 'NET', message: 'net err', recoverable: true } }],
      [{ type: 'text', text: 'recovered' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } }
    const messages = await runLoop([], '问', opts)
    expect(onWarn).toHaveBeenCalled()
    expect(last(messages)).toMatchObject({ type: 'text', text: 'recovered' })
  })

  it('recoverable 错误回滚半截 assistant（P1-9）：retry 不留连续 assistant', async () => {
    const p = new MockProvider([
      [{ type: 'text', text: '半截' }, { type: 'error', error: { code: 'NET', message: 'err', recoverable: true } }],
      [{ type: 'text', text: '完整' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, []))
    // P1-9：半截 assistant 被 messages.pop() 回滚，retry 后只剩完整 assistant（无连续两个 → 避免 Anthropic 400）
    const assistants = messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect((assistants[0].content[0] as { text: string }).text).toBe('完整')
  })

  it('fatal 错误 → 抛顶层', async () => {
    const p = new MockProvider([
      [{ type: 'error', error: { code: 'FATAL', message: 'fatal', recoverable: false } }],
    ])
    await expect(runLoop([], '问', makeOpts(p, []))).rejects.toThrow(/fatal/i)
  })

  it('length → break + onWarn（保留半截回答）', async () => {
    const onWarn = vi.fn()
    const p = new MockProvider([
      [{ type: 'text', text: 'partial...' }, { type: 'done', stop_reason: 'length' }],
    ])
    const opts = { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } }
    const messages = await runLoop([], '问', opts)
    expect(onWarn).toHaveBeenCalled()
    expect(messages).toHaveLength(2)
    expect(last(messages)).toMatchObject({ type: 'text', text: 'partial...' })
  })

  it('空 tool_use 防护（stop=tool_use 但无工具块）→ continue 不空转', async () => {
    const p = new MockProvider([
      [{ type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, []))
    expect(last(messages)).toMatchObject({ type: 'text', text: 'ok' })
  })

  it('abort 中断 → break 不重试（P0#3 防回归）', async () => {
    let calls = 0
    const abortProvider: LLMProvider = {
      type: 'mock',
      async *run() {
        calls++
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      },
    }
    const messages = await runLoop([], '问', makeOpts(abortProvider, []))
    expect(calls).toBe(1) // 只调一次，没重试（P0#3：abort 不走 recoverable 死循环）
    expect(messages[0].role).toBe('user')
  })
})

describe('M5 压缩集成（onBeforeRequest hook + 400 兜底）', () => {
  it('onBeforeRequest 返回的投影子集喂 provider（非全量 messages）', async () => {
    let received: Message[] = []
    const spy: LLMProvider = {
      type: 'spy',
      async *run(req) {
        received = req.messages
        yield { type: 'text', text: 'ok' }
        yield { type: 'done', stop_reason: 'end' }
      },
    }
    const projection: Message[] = [{ role: 'user', content: [{ type: 'text', text: '投影子集' }] }]
    const onBeforeRequest = vi.fn(async () => projection)
    await runLoop([], 'hello', { ...makeOpts(spy, []), onBeforeRequest })
    expect(onBeforeRequest).toHaveBeenCalled()
    expect(received).toEqual(projection) // provider 收到投影子集，非全量
  })

  it('无 onBeforeRequest → messages 过滤 boundary 后喂 provider', async () => {
    let received: Message[] = []
    const spy: LLMProvider = {
      type: 'spy',
      async *run(req) {
        received = req.messages
        yield { type: 'text', text: 'ok' }
        yield { type: 'done', stop_reason: 'end' }
      },
    }
    const lines: HistoryLine[] = [
      { compact_boundary: true, summary: '旧摘要', tailStartIndex: 0, preTokens: 0 },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ]
    await runLoop(lines, '新问题', makeOpts(spy, []))
    // provider 收到的 messages 不含 boundary
    expect(received.every((m) => !('compact_boundary' in m))).toBe(true)
  })

  it('CONTEXT_TOO_LONG 400 → onBeforeRequest(overflow) + onCompacted + 重试成功', async () => {
    const p = new MockProvider([
      [{ type: 'error', error: { code: 'CONTEXT_TOO_LONG', message: 'too long', recoverable: false } }],
      [{ type: 'text', text: '压缩后回复' }, { type: 'done', stop_reason: 'end' }],
    ])
    const triggers: (string | undefined)[] = []
    const onCompacted = vi.fn()
    const onBeforeRequest = vi.fn(async (messages: HistoryLine[], trigger?: string) => {
      triggers.push(trigger)
      // P1-4: overflow 时追加 boundary（模拟真压缩），让 loop 的 lenBefore 检查通过
      if (trigger === 'overflow') {
        messages.push({ compact_boundary: true, summary: '压缩', tailStartIndex: 0, preTokens: 0 })
      }
      return messages.filter((m): m is Message => !('compact_boundary' in m))
    })
    const messages = await runLoop([], 'hello', { ...makeOpts(p, []), onBeforeRequest, onCompacted })
    expect(triggers).toContain('overflow') // 400 触发 overflow 压缩
    // P1-6: onCompacted 由 hook 统一调（此处 mock 绕过 hook，loop 不再直接调）
    const lastMsg = messages.at(-1) as Message
    expect((lastMsg.content[0] as { text: string }).text).toBe('压缩后回复')
  })
})
