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
  it('2026-09-03：QUOTA_EXCEEDED 不退避直接终止 + onError 常驻提示（额度类 429 语义分流）', async () => {
    // 真机病灶：智谱 1308 五小时窗口上限曾按 RATE_LIMIT 走 5 次指数退避白烧大请求，
    // 期间 UI 只有 12s warn 闪现——用户观感「没提示就停了」。分流后 no_retry 温和终止
    const quotaErr = Object.assign(
      new Error('429 {"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-03 18:19:36 重置。"}}'),
      { status: 429, error: { code: '1308', message: '已达到 5 小时的使用上限。您的限额将在 2026-09-03 18:19:36 重置。' } },
    )
    let calls = 0
    const p: LLMProvider = {
      type: 'quota-mock',
      async *run(): AsyncIterable<Delta> {
        calls += 1
        throw quotaErr
      },
    }
    const onWarn = vi.fn()
    const onError = vi.fn()
    const messages = await runLoop([], '问', {
      ...makeOpts(p, []),
      callbacks: { onText: vi.fn(), onWarn, onError },
    })
    expect(calls).toBe(1) // 不退避重试（旧实现会 5 次）
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain('18:19:36') // 重置时间上屏
    expect(String(onError.mock.calls[0]?.[0])).toContain('本轮已终止')
    expect(onWarn).not.toHaveBeenCalledWith(expect.stringContaining('重试')) // 不走退避路径
    expect(messages.length).toBeGreaterThan(0)
  })

  it('F-21 迭代上限耗尽：onWarn 提示（不再静默 return）', async () => {
    // 每轮都要求工具调用 → 走满 maxIterations=2（脚本耗尽后 MockProvider 回退 done/end，
    // 但这里显式给两轮 tool_use 保证耗尽路径）
    const toolRound = [
      { type: 'tool_use_start' as const, id: 't', name: 'echo' },
      { type: 'tool_use_delta' as const, id: 't', partial_json: '{"msg":"x"}' },
      { type: 'tool_use_end' as const, id: 't' },
      { type: 'done' as const, stop_reason: 'tool_use' as const },
    ]
    const p = new MockProvider([toolRound, structuredClone(toolRound)])
    const onWarn = vi.fn()
    const messages = await runLoop([], '问', {
      ...makeOpts(p, [echoTool]),
      maxIterations: 2,
      callbacks: { onText: vi.fn(), onWarn },
    })
    expect(messages.length).toBeGreaterThan(0)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('迭代上限'))
  })

  it('F-21 正常结束（stop=end break）不触发耗尽告警', async () => {
    const p = new MockProvider([[{ type: 'text', text: 'hi' }, { type: 'done', stop_reason: 'end' }]])
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).not.toHaveBeenCalledWith(expect.stringContaining('迭代上限'))
  })

  it('2026-09-03：onExhausted 结构化回调（耗尽触发；正常结束不触发）', async () => {
    const toolRound = [
      { type: 'tool_use_start' as const, id: 't', name: 'echo' },
      { type: 'tool_use_delta' as const, id: 't', partial_json: '{"msg":"x"}' },
      { type: 'tool_use_end' as const, id: 't' },
      { type: 'done' as const, stop_reason: 'tool_use' as const },
    ]
    const p = new MockProvider([toolRound, structuredClone(toolRound)])
    const onExhausted = vi.fn()
    await runLoop([], '问', { ...makeOpts(p, [echoTool]), maxIterations: 2, callbacks: { onText: vi.fn(), onExhausted } })
    expect(onExhausted).toHaveBeenCalledWith(2)
    const p2 = new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]])
    const onExhausted2 = vi.fn()
    await runLoop([], '问', { ...makeOpts(p2, []), callbacks: { onText: vi.fn(), onExhausted: onExhausted2 } })
    expect(onExhausted2).not.toHaveBeenCalled()
  })

  it('2026-09-03：system 函数形态每轮请求时求值（子代理轮数感知通道——静态串不受影响）', async () => {
    const seen: string[] = []
    class CaptureProvider implements LLMProvider {
      readonly type = 'capture'
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        seen.push(req.system)
        yield { type: 'text', text: 'ok' }
        yield { type: 'done', stop_reason: 'end' }
      }
    }
    let n = 0
    await runLoop([], '问', {
      ...makeOpts(new CaptureProvider(), []),
      system: () => `base-第${++n}轮`,
    })
    expect(seen[0]).toBe('base-第1轮')
    expect(n).toBe(1)
  })

  it('2026-09-03 审阅锁定：onIter 先于 system 求值——子代理首轮请求即见「第 1/M 轮」', async () => {
    // 若有人把 onIter 挪到 provider.run 之后，首轮 system 求值拿到旧值（第 0 轮）——
    // 子代理轮数感知的时序前提由本用例锚定（此前测试用手动 onIter/独立计数器均未锁顺序）
    const seen: string[] = []
    class CaptureProvider implements LLMProvider {
      readonly type = 'capture'
      async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
        seen.push(req.system)
        yield { type: 'text', text: 'ok' }
        yield { type: 'done', stop_reason: 'end' }
      }
    }
    const marker = { v: 0 }
    await runLoop([], '问', {
      ...makeOpts(new CaptureProvider(), []),
      system: () => `第${marker.v}轮`,
      callbacks: { onText: vi.fn(), onIter: (iter: number) => { marker.v = iter } },
    })
    expect(seen[0]).toBe('第1轮')
  })

  it('2026-09-03 审阅修复批：同轮多个 readonly 工具真并行（墙钟重叠哨兵——提示词并发承诺的机制锁）', async () => {
    // 提示词明示「同轮多个 task 调用即并行执行」——本用例锁 executeTools 的 readonly
    // Promise.all 底座：两个 120ms 慢 readonly 工具同轮执行，墙钟必须 < 2×（串行则 ≥240ms）。
    // 若未来 executeTools 被重构为串行，提示词对模型撒谎且本测试变红
    // 审阅修复（测试席 P2·二轮补遗）：墙钟断言（<240ms 贴串行边界）改**并发计数哨兵**——
    // 执行中段观察到 in-flight ≥2 才是真并行（CI 慢机毫秒抖动不再假红；串行退化仍必红：
    // 串行时 slowA 结束 slowB 才开始，in-flight 峰值恒 1）
    let inFlight = 0
    let maxSeen = 0
    const slow = (name: string): Tool => ({
      name,
      description: name,
      input_schema: { type: 'object', properties: {} },
      readonly: true,
      async execute() {
        inFlight += 1
        maxSeen = Math.max(maxSeen, inFlight)
        await new Promise((r) => setTimeout(r, 120))
        inFlight -= 1
        return { content: 'ok' }
      },
    })
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 's1', name: 'slowA' },
        { type: 'tool_use_end', id: 's1' },
        { type: 'tool_use_start', id: 's2', name: 'slowB' },
        { type: 'tool_use_end', id: 's2' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    await runLoop([], '问', { ...makeOpts(p, [slow('slowA'), slow('slowB')]) })
    expect(maxSeen).toBeGreaterThanOrEqual(2) // 并行：两工具执行期真实重叠
  })

  it('F-21（审阅 P1-5①）：最后一轮撞 CONTEXT_TOO_LONG 压缩重试（continue 路径）仍有耗尽提示', async () => {
    // 每轮都 CONTEXT_TOO_LONG 且压缩成功 → continue 重试；maxIterations=2 走完 → 必须报耗尽
    // （修复前 exhausted 赋值在 continue 之后：用户看到「已压缩对话后重试」但重试永不来且无耗尽提示）
    const p = new MockProvider([
      [{ type: 'error', error: { code: 'CONTEXT_TOO_LONG', message: 'too long', recoverable: false } }],
      [{ type: 'error', error: { code: 'CONTEXT_TOO_LONG', message: 'too long', recoverable: false } }],
    ])
    const onWarn = vi.fn()
    const onBeforeRequest = vi.fn(async (messages: HistoryLine[], trigger?: string) => {
      if (trigger === 'overflow') messages.push({ compact_boundary: true, summary: '压缩', tailStartIndex: 0, preTokens: 0 })
      return messages.filter((m): m is Message => !('compact_boundary' in m))
    })
    await runLoop([], 'hello', {
      ...makeOpts(p, []),
      maxIterations: 2,
      onBeforeRequest,
      callbacks: { onText: vi.fn(), onWarn },
    })
    expect(onWarn).toHaveBeenCalledWith('上下文超限，已压缩对话后重试') // 压缩路径确实走过
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('迭代上限')) // 且耗尽不漏报
  })

  it('F-21（审阅 P1-5②）：最后一轮撞 empty_tool_use（continue 路径）也有耗尽提示', async () => {
    // 每轮 stop=tool_use 但无工具块 → continue；maxIterations=2 走完 → 报耗尽
    // （修复前同样漏报——「跳过本轮」文案失准，实为终止）
    const p = new MockProvider([
      [{ type: 'done', stop_reason: 'tool_use' }],
      [{ type: 'done', stop_reason: 'tool_use' }],
    ])
    const onWarn = vi.fn()
    await runLoop([], 'hello', {
      ...makeOpts(p, []),
      maxIterations: 2,
      callbacks: { onText: vi.fn(), onWarn },
    })
    expect(onWarn).toHaveBeenCalledWith('LLM 要求工具调用但未给出工具，跳过本轮')
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('迭代上限'))
  })

  it('F-21（审阅 P1-5）：length/abort/retryable:false 各 break 不误报耗尽', async () => {
    // length break
    const pLen = new MockProvider([[{ type: 'text', text: 'x' }, { type: 'done', stop_reason: 'length' }]])
    const warnLen = vi.fn()
    await runLoop([], '问', { ...makeOpts(pLen, []), callbacks: { onText: vi.fn(), onWarn: warnLen } })
    expect(warnLen).not.toHaveBeenCalledWith(expect.stringContaining('迭代上限'))
    // retryable:false break
    const p400: LLMProvider = {
      type: 'mock',
      async *run() {
        yield { type: 'error', error: { code: 'HTTP_ERROR', message: '400', recoverable: true, retryable: false } }
      },
    }
    const warn400 = vi.fn()
    await runLoop([], '问', { ...makeOpts(p400, []), callbacks: { onText: vi.fn(), onWarn: warn400 } })
    expect(warn400).not.toHaveBeenCalledWith(expect.stringContaining('迭代上限'))
  })

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

  it('length → 自动续写（2026-08-30 行为变更：不再 break；半截回答保留+续写指令追加）', async () => {
    const onWarn = vi.fn()
    const p = new MockProvider([
      [{ type: 'text', text: 'partial...' }, { type: 'done', stop_reason: 'length' }],
      [{ type: 'text', text: '...rest' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } }
    const messages = await runLoop([], '问', opts)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('已自动续写（1/3）'))
    expect(messages).toHaveLength(4)
    expect(last(messages)).toMatchObject({ type: 'text', text: '...rest' })
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


describe('M11-P0：stop 谎报防御（provider 报 end 但有 tool_use → 按工具继续）', () => {
  it('谎报 end + tool_use_end：工具照执行、循环不终止', async () => {
    const echo: Tool = {
      name: 'echo',
      description: '回显',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      readonly: true,
      async execute(args) {
        return { content: (args as { text: string }).text }
      },
    }
    const provider = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_delta', id: 't1', partial_json: '{"text":"hi"}' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'end' }, // ← 谎报：有 tool_use 却报 end
      ],
      [{ type: 'text', text: '收到结果' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], 'go', makeOpts(provider, [echo]))
    // 工具被执行（tool_result 在 messages）
    const resultMsg = messages.find((m) => !('rewind' in m) && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    expect(resultMsg).toBeDefined()
    // 第二轮文本也在（循环没有在谎报处终止）
    const textMsg = messages.find((m) => !('rewind' in m) && m.role === 'assistant' && m.content.some((b) => b.type === 'text' && (b as { text: string }).text === '收到结果'))
    expect(textMsg).toBeDefined()
  })
})


describe('M11-P7：插话步间注入（pollUserInput）', () => {
  it('迭代顶部拉取（iter≥2）→ 追加 user 消息 → 下一轮请求可见（在 tool_result 之后）', async () => {
    const requests: Message[][] = []
    const echo: Tool = {
      name: 'echo',
      description: '回显',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        interjectQueue.push('改用方案B')
        return { content: 'ok' }
      },
    }
    const interjectQueue: string[] = []
    const provider = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '收到插话' }, { type: 'done', stop_reason: 'end' }],
    ])
    const origRun = provider.run.bind(provider)
    ;(provider as unknown as { run: typeof provider.run }).run = async function* (req) {
      requests.push(req.messages as Message[])
      yield* origRun(req)
    }
    const opts = makeOpts(provider, [echo])
    opts.pollUserInput = () => interjectQueue.splice(0).join('\n\n') || null
    const messages = await runLoop([], '开始', opts)
    // 第二轮请求的 messages 含插话文本，且位于 tool_result 之后
    const second = requests[1]
    const texts = second.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text))
    // F-35：插话带引导包装（CC wrapCommandText 同款）——防模型只答插话丢原任务
    const wrapped = texts.find((t) => t.includes('改用方案B'))
    expect(wrapped).toContain('用户在任务执行中发来新消息')
    expect(wrapped).toContain('继续原任务')
    const resultIdx = second.findIndex((m) => m.content.some((b) => b.type === 'tool_result'))
    const interjectIdx = second.findIndex((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === wrapped))
    expect(interjectIdx).toBeGreaterThan(resultIdx)
    // 最终回复存在（循环未被插话打断）
    expect(messages.some((m) => !('rewind' in m) && m.role === 'assistant' && m.content.some((b) => b.type === 'text' && (b as { text: string }).text === '收到插话'))).toBe(true)
  })

  it('iter=1 不拉取（首轮输入就是 userInput，避免连续双 user）；未配置回调零行为变化', async () => {
    let polled = false
    const provider = new MockProvider([[{ type: 'text', text: 'hi' }, { type: 'done', stop_reason: 'end' }]])
    const opts = makeOpts(provider, [])
    opts.pollUserInput = () => {
      polled = true
      return null
    }
    await runLoop([], 'q', opts)
    expect(polled).toBe(false) // 单轮流，iter=1 从不拉取
  })

  // 2026-09-03 机器消息归属根治：插话消息带 meta——UI 据此分流（不渲染成普通用户气泡）
  it('插话消息带 meta:{kind:interject}（归属根治标记）', async () => {
    const interjectQueue: Array<string | { text: string; kind?: 'review' }> = ['改用方案B']
    const echo: Tool = {
      name: 'echo',
      description: '回显',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        return { content: 'ok' }
      },
    }
    const provider = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '收到' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = makeOpts(provider, [echo])
    opts.pollUserInput = () => interjectQueue.splice(0)[0] ?? null
    const messages = await runLoop([], '开始', opts)
    const withMeta = messages.filter((m) => !('rewind' in m) && (m as Message).meta !== undefined) as Array<
      Message & { meta: { kind: string } }
    >
    expect(withMeta.length).toBe(1)
    expect(withMeta[0].meta.kind).toBe('interject')
  })
})

describe('安全审阅修复：timeout_ms 强制 + retryable 消费', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('声明 timeout_ms 的工具超时 → recoverable 超时 is_error（文案含工具名与毫秒数）', async () => {
    const slowTool: Tool = {
      name: 'slow_tool',
      description: '慢工具',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      timeout_ms: 100,
      async execute() {
        await sleep(500)
        return { content: 'late' }
      },
    }
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'slow_tool' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], 'go', makeOpts(p, [slowTool]))
    const tr = messages[2].content[0] as Record<string, unknown>
    expect(tr.is_error).toBe(true)
    expect(tr.content).toContain('slow_tool')
    expect(tr.content).toContain('100')
    expect(tr.content).toContain('超时')
  })

  it('未声明 timeout_ms 的慢工具不受影响（照常完成）', async () => {
    const slowTool: Tool = {
      name: 'no_limit_tool',
      description: '未声明超时的慢工具',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        await sleep(80)
        return { content: 'slow but ok' }
      },
    }
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'no_limit_tool' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], 'go', makeOpts(p, [slowTool]))
    const tr = messages[2].content[0] as Record<string, unknown>
    expect(tr.is_error).toBeFalsy()
    expect(tr.content).toBe('slow but ok')
  })

  it('recoverable + retryable:false（400 客户端错）→ 不退避重试，只请求 1 次即终止', async () => {
    let calls = 0
    const p: LLMProvider = {
      type: 'mock',
      async *run() {
        calls++
        yield {
          type: 'error',
          error: { code: 'HTTP_ERROR', message: '参数错误（400）', recoverable: true, retryable: false },
        }
      },
    }
    const onWarn = vi.fn()
    const messages = await runLoop([], '问', {
      ...makeOpts(p, []),
      callbacks: { onText: vi.fn(), onWarn },
    })
    expect(calls).toBe(1) // 不空转：没退避重试 3 次
    expect(onWarn).toHaveBeenCalledWith('参数错误（400）')
    expect(messages[0].role).toBe('user') // 温和终止（非 fatal throw）
  })

  it('429（retryable:true）→ 仍退避重试至成功', async () => {
    const p = new MockProvider([
      [{ type: 'error', error: { code: 'RATE_LIMIT', message: '限流', recoverable: true, retryable: true } }],
      [{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }],
    ])
    const messages = await runLoop([], '问', makeOpts(p, []))
    expect(last(messages)).toMatchObject({ type: 'text', text: 'ok' })
  })

  it('onSensitiveAccess 透传为 toolCtx.confirmSensitive（工具可拿到确认通路）', async () => {
    let received = ''
    const probeTool: Tool = {
      name: 'probe',
      description: '探测工具',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute(_args, ctx) {
        received = typeof ctx.confirmSensitive === 'function' ? 'has' : 'missing'
        return { content: 'ok' }
      },
    }
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'probe' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ])
    const opts = makeOpts(p, [probeTool])
    opts.onSensitiveAccess = async () => true
    await runLoop([], 'go', opts)
    expect(received).toBe('has')
  })
})

describe('runLoop：中断分类（Ctrl+C 中断链路）', () => {
  /** 模拟 Anthropic SDK MessageStream 真实 abort 语义：pending 消费被 reject，
   *  抛 e.name='APIUserAbortError'（SDK 把裸 AbortError 换名重抛——不是 'AbortError'） */
  class AbortRealProvider implements LLMProvider {
    readonly type = 'mock'
    async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
      yield { type: 'text', text: '思考中' }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 30_000)
        req.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          const e = new Error('Request was aborted.')
          e.name = 'APIUserAbortError'
          reject(e)
        }, { once: true })
      })
      yield { type: 'done', stop_reason: 'end' }
    }
  }

  it('APIUserAbortError 判为 abort：立即终止，不走退避重试/不发假 warn', async () => {
    const ac = new AbortController()
    const opts = { ...makeOpts(new AbortRealProvider(), []), signal: ac.signal }
    const warns: string[] = []
    const acts: string[] = []
    ;(opts.callbacks.onWarn as ReturnType<typeof vi.fn>).mockImplementation((m: string) => warns.push(m))
    opts.callbacks.onActivity = (s) => acts.push(s)
    const t0 = Date.now()
    const runP = runLoop([], 'hi', opts)
    setTimeout(() => ac.abort(), 80)
    await runP
    expect(Date.now() - t0).toBeLessThan(1500) // 不等退避（BASE_RETRY_MS 500ms 起）
    expect(acts).toContain('aborted')
    expect(acts).not.toContain('retry')
    expect(warns).toEqual([]) // 中断不是错误，不该刷「Request was aborted.」
  })
})

describe('runLoop：真实 SDK abort 静默收尾（pty 实测形态——abort 不抛错，流正常结束）', () => {
  /** 模拟真实 @anthropic-ai/sdk + undici：fetch abort 后事件流迭代器**正常 return**
   *  （无异常、无 done 帧截断收尾）——loop 若只认异常会把中断当正常 end */
  class SilentAbortProvider implements LLMProvider {
    readonly type = 'mock'
    async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
      yield { type: 'text', text: '思考中' }
      yield {
        type: 'tool_use_start',
        id: 't-silent',
        name: 'echo',
      }
      yield { type: 'tool_use_end', id: 't-silent' }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30_000)
        req.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
      // 无 done 帧，生成器直接结束（真实 SDK 截断形态）
    }
  }

  it('signal 已断时流静默结束 → 判 aborted：工具不执行（stop-lying 防御不让路）', async () => {
    const ac = new AbortController()
    const toolExec = vi.fn(async () => ({ content: '不该执行' }))
    const echo: Tool = {
      name: 'echo', description: 'e',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      execute: toolExec,
    }
    const reg = new ToolRegistryImpl()
    reg.register(echo)
    const acts: string[] = []
    const opts: LoopRunOptions = {
      provider: new SilentAbortProvider(),
      tools: reg,
      logger: noopLogger,
      history: new NoopHistoryStore(),
      callbacks: {
        onText: vi.fn(),
        onActivity: (s) => acts.push(s),
      },
      providerReq: { name: 't', baseURL: 'http://x', apiKey: 'k', model: 'm' },
      system: 's',
      maxIterations: 10,
      toolCtx: { cwd: process.cwd(), signal: ac.signal },
      signal: ac.signal,
    }
    const runP = runLoop([], 'go', opts)
    setTimeout(() => ac.abort(), 80)
    await runP
    expect(acts).toContain('aborted')
    expect(toolExec).not.toHaveBeenCalled()
  })
})

describe('runLoop：批1a 流内逐 chunk signal 硬检查（真机根因形态）', () => {
  /** 2026-09-02 四角色审阅的形态陷阱：上面 AbortReal/Silent 两个模板都**自听 signal** 才断，
   *  测不出真机根因形态（openai signal 传参 bug 期 provider 层零响应，按自己节奏吐流）。
   *  本 provider 完全无视 signal，20ms/字 慢滴 50 字——唯一能及时断的位置就是 loop 的流内
   *  逐 chunk 检查（signal 传参修复管静默流；本测锁的是活跃流第二道保险） */
  class DeafSlowDripProvider implements LLMProvider {
    readonly type = 'mock'
    async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
      for (let i = 1; i <= 50; i++) {
        await new Promise((r) => setTimeout(r, 20))
        yield { type: 'text', text: `字${i} ` }
      }
      yield { type: 'done', stop_reason: 'end' }
    }
  }

  it('中途 abort → 下一 chunk 即断（不等 50×20ms 自然结束）：判 aborted、部分产出固化、无退避', async () => {
    const ac = new AbortController()
    const acts: string[] = []
    const texts: string[] = []
    const opts = {
      ...makeOpts(new DeafSlowDripProvider(), []),
      signal: ac.signal,
      callbacks: {
        onText: (t: string) => texts.push(t),
        onActivity: (s: string) => acts.push(s),
      },
    }
    const t0 = Date.now()
    const runP = runLoop([], 'hi', opts)
    setTimeout(() => ac.abort(), 80) // 流进行约 1/3 处
    const messages = await runP
    const elapsed = Date.now() - t0
    // 不等流自然结束（50×20=1000ms）也不吃退避（BASE_RETRY_MS 500ms 起）：abort 后下一 chunk 即断
    expect(elapsed).toBeLessThan(600)
    expect(acts).toContain('aborted')
    expect(acts).not.toContain('retry')
    // 部分产出固化：收到若干字但远未收满 50，assistant 是最后一条消息
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.length).toBeLessThan(50)
    expect(messages.at(-1)?.role).toBe('assistant')
  })
})

describe('runLoop：图片毒化出路指引（2026-08-29 P1 处置，CC/codex 同思路）', () => {
  /** 返回带图 blocks 的只读工具（模拟 read_file 读图） */
  const imgTool: Tool = {
    name: 'read_img',
    description: 'read image',
    input_schema: { type: 'object', properties: {}, required: [] },
    readonly: true,
    async execute() {
      return {
        content: '已读取图片',
        blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }],
      }
    },
  }
  const p400 = (): LLMProvider => ({
    type: 'mock',
    async *run() {
      yield { type: 'error', error: { code: 'HTTP_ERROR', message: '400 Bad Request', recoverable: true, retryable: false } }
    },
  })

  it('会话含图（tool_result.blocks）→ 非重试终止 warn 追加 /rewind·/compact·/model 出路指引', async () => {
    // 第一轮工具调用产出带图 tool_result，第二轮 provider 直接抛 retryable:false
    let call = 0
    const p2: LLMProvider = {
      type: 'mock',
      async *run() {
        call += 1
        if (call === 1) {
          yield { type: 'tool_use_start', id: 't1', name: 'read_img' } as Delta
          yield { type: 'tool_use_end', id: 't1' } as Delta
          yield { type: 'done', stop_reason: 'tool_use' } as Delta
          return
        }
        yield { type: 'error', error: { code: 'HTTP_ERROR', message: '400 Bad Request', recoverable: true, retryable: false } }
      },
    }
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p2, [imgTool]), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'))
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('/rewind'))
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('/compact'))
  })

  it('会话无图 → 同样错误 warn 不带指引（不噪音化）', async () => {
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p400(), []), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).toHaveBeenCalledWith('400 Bad Request')
    expect(onWarn).not.toHaveBeenCalledWith(expect.stringContaining('/rewind'))
  })
})

describe('runLoop：空响应轮防御（2026-08-30 用户报障——端点断流静默收尾零提示）', () => {
  it('合法空响应（零 delta 零 tool_use，stop_reason=end）→ onWarn 警告 + 轮正常结束不挂起', async () => {
    const p = new MockProvider([[{ type: 'done', stop_reason: 'end' }]])
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('空响应'))
  })
  it('正常轮（有 text）不误报', async () => {
    const p = new MockProvider([[{ type: 'text', text: '你好' }, { type: 'done', stop_reason: 'end' }]])
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).not.toHaveBeenCalled()
  })
  it('aborted 静默收尾不叠加空响应警告（专属路径已另有兜底）', async () => {
    const ac = new AbortController()
    ac.abort()
    const p = new MockProvider([[{ type: 'done', stop_reason: 'end' }]])
    const onWarn = vi.fn()
    await runLoop([], '问', {
      ...makeOpts(p, []),
      callbacks: { onText: vi.fn(), onWarn },
      signal: ac.signal, // loop 的 abort 权威判据是 opts.signal（provider.run 与 252 行兜底都读它）
      toolCtx: { cwd: process.cwd(), signal: ac.signal },
    })
    expect(onWarn).not.toHaveBeenCalledWith(expect.stringContaining('空响应'))
  })
})

describe('runLoop：max_tokens 自动续写（2026-08-30 对标 CC——meta 续写+3 次上限+截断 tool_use 丢弃）', () => {
  it('length 截断 → 追加 user 续写指令接着写；续写成功后正常结束', async () => {
    const p = new MockProvider([
      [{ type: 'text', text: '前半段' }, { type: 'done', stop_reason: 'length' }],
      [{ type: 'text', text: '后半段' }, { type: 'done', stop_reason: 'end' }],
    ])
    const onWarn = vi.fn()
    const messages = await runLoop([], '问', { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn } })
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('已自动续写（1/3）'))
    // messages 尾序：user(问) assistant(前半段) user(续写指令) assistant(后半段)
    const roles = messages.map((m) => ('role' in m ? m.role : 'boundary'))
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    const continueMsg = messages[2] as Message
    expect((continueMsg.content[0] as { text: string }).text).toContain('继续输出')
    const lastAssistant = messages[3] as Message
    expect((lastAssistant.content[0] as { text: string }).text).toBe('后半段')
  })

  it('截断轮里的 tool_use 不执行且从 messages 剥除（半截 JSON 不安全，无配对 result 防 400）', async () => {
    let executed = false
    const t: Tool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: true,
      async execute() {
        executed = true
        return { content: 'should-not-happen' }
      },
    }
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_delta', id: 't1', partial_json: '{"ms' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'length' },
      ],
      [{ type: 'text', text: '续写内容' }, { type: 'done', stop_reason: 'end' }],
    ])
    const onWarn = vi.fn()
    const messages = await runLoop([], '问', { ...makeOpts(p, [t]), callbacks: { onText: vi.fn(), onWarn } })
    expect(executed).toBe(false)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('1 个未完成的工具调用已丢弃'))
    const assistant = messages.find((m) => 'role' in m && m.role === 'assistant') as Message
    expect(assistant.content.some((b) => b.type === 'tool_use')).toBe(false)
  })

  it('连续 3 次截断 → 耗尽走 onError 常驻通道并结束（不再无限续写）', async () => {
    const lengthTurn: Delta[] = [{ type: 'text', text: 'x' }, { type: 'done', stop_reason: 'length' }]
    const p = new MockProvider([lengthTurn, lengthTurn, lengthTurn, lengthTurn])
    const onError = vi.fn()
    const onWarn = vi.fn()
    await runLoop([], '问', { ...makeOpts(p, []), callbacks: { onText: vi.fn(), onWarn, onError } })
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('已自动续写（3/3）'))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('已停止自动续写'))
  })
})
