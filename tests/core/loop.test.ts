import { describe, it, expect, vi } from 'vitest'
import { runLoop, type LoopRunOptions } from '../../src/core/loop.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, Message } from '../../src/core/types.js'
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
