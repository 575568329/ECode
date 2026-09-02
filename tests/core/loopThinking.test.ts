/**
 * B1 批测试：思考链路回调 + 工具事件增强 + textBuf 按 block 分段
 * （活动流统一布局详设 v1.7 §4——Delta 透传 / onToolStart 带 id / onToolExecute 时机 / 分段固化）。
 */
import { describe, it, expect, vi } from 'vitest'
import { runLoop, type LoopRunOptions } from '../../src/core/loop.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, HistoryLine, Message } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'

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

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  readonly: true,
  async execute(args) {
    return { content: (args as { msg: string }).msg }
  },
}

const gatedTool: Tool = {
  name: 'edit_file',
  description: 'edit',
  input_schema: { type: 'object', properties: {} , required: [] },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
}

function makeOpts(provider: LLMProvider, tools: Tool[], confirm?: LoopRunOptions['confirm']): LoopRunOptions {
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
    ...(confirm !== undefined ? { confirm } : {}),
  }
}

describe('B1：思考链路回调与工具事件（活动流 §4）', () => {
  it('thinking/thinking_end Delta 透传到 onThinking/onThinkingEnd（带 blockIndex）', async () => {
    const p = new MockProvider([[
      { type: 'thinking', blockIndex: 0, text: '想一' },
      { type: 'thinking', blockIndex: 0, text: '想二' },
      { type: 'thinking_end', blockIndex: 0 },
      { type: 'text', text: '答案' },
      { type: 'done', stop_reason: 'end' },
    ]])
    const onThinking = vi.fn()
    const onThinkingEnd = vi.fn()
    const opts = makeOpts(p, [])
    opts.callbacks.onThinking = onThinking
    opts.callbacks.onThinkingEnd = onThinkingEnd
    await runLoop([] as HistoryLine[], { role: 'user', content: [{ type: 'text', text: 'q' }] } as Message, opts)
    expect(onThinking.mock.calls).toEqual([[0, '想一'], [0, '想二']])
    expect(onThinkingEnd.mock.calls).toEqual([[0]])
  })

  it('onToolStart 携带真实 tool_use id（D7）', async () => {
    const p = new MockProvider([[
      { type: 'tool_use_start', id: 'tu_1', name: 'echo' },
      { type: 'tool_use_delta', id: 'tu_1', partial_json: '{"msg":"hi"}' },
      { type: 'tool_use_end', id: 'tu_1' },
      { type: 'done', stop_reason: 'tool_use' },
    ], [
      { type: 'text', text: '完' },
      { type: 'done', stop_reason: 'end' },
    ]])
    const onToolStart = vi.fn()
    const opts = makeOpts(p, [echoTool])
    opts.callbacks.onToolStart = onToolStart
    await runLoop([] as HistoryLine[], { role: 'user', content: [{ type: 'text', text: 'q' }] } as Message, opts)
    expect(onToolStart).toHaveBeenCalledWith('echo', 'tu_1')
  })

  it('onToolExecute 在执行前触发（name/id/input 透传，D9）', async () => {
    const p = new MockProvider([[
      { type: 'tool_use_start', id: 'tu_2', name: 'echo' },
      { type: 'tool_use_delta', id: 'tu_2', partial_json: '{"msg":"hey"}' },
      { type: 'tool_use_end', id: 'tu_2' },
      { type: 'done', stop_reason: 'tool_use' },
    ], [
      { type: 'text', text: '完' },
      { type: 'done', stop_reason: 'end' },
    ]])
    const onToolExecute = vi.fn()
    const opts = makeOpts(p, [echoTool])
    opts.callbacks.onToolExecute = onToolExecute
    await runLoop([] as HistoryLine[], { role: 'user', content: [{ type: 'text', text: 'q' }] } as Message, opts)
    expect(onToolExecute).toHaveBeenCalledWith('echo', 'tu_2', { msg: 'hey' })
  })

  it('onToolExecute 放 confirm 之后：副作用工具被拒时不触发', async () => {
    const p = new MockProvider([[
      { type: 'tool_use_start', id: 'tu_3', name: 'edit_file' },
      { type: 'tool_use_delta', id: 'tu_3', partial_json: '{}' },
      { type: 'tool_use_end', id: 'tu_3' },
      { type: 'done', stop_reason: 'tool_use' },
    ], [
      { type: 'text', text: '被拒了' },
      { type: 'done', stop_reason: 'end' },
    ]])
    const onToolExecute = vi.fn()
    const opts = makeOpts(p, [gatedTool], async () => false)
    opts.callbacks.onToolExecute = onToolExecute
    await runLoop([] as HistoryLine[], { role: 'user', content: [{ type: 'text', text: 'q' }] } as Message, opts)
    expect(onToolExecute).not.toHaveBeenCalled()
  })

  it('textBuf 按 block 分段：text→tool→text 固化为三个 block 原序（审阅协议 P2-2）', async () => {
    const p = new MockProvider([[
      { type: 'text', text: '前段' },
      { type: 'tool_use_start', id: 'tu_4', name: 'echo' },
      { type: 'tool_use_delta', id: 'tu_4', partial_json: '{"msg":"x"}' },
      { type: 'tool_use_end', id: 'tu_4' },
      { type: 'text', text: '后段' },
      { type: 'done', stop_reason: 'tool_use' },
    ], [
      { type: 'text', text: '收尾' },
      { type: 'done', stop_reason: 'end' },
    ]])
    const opts = makeOpts(p, [echoTool])
    const messages: HistoryLine[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] } as Message]
    await runLoop(messages, { role: 'user', content: [{ type: 'text', text: 'q' }] } as Message, opts)
    const assistant = [...messages].reverse().find((m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))
    expect(assistant).toBeDefined()
    const kinds = assistant!.content.map((b) => b.type)
    expect(kinds).toEqual(['text', 'tool_use', 'text'])
    expect((assistant!.content[0] as { text: string }).text).toBe('前段')
    expect((assistant!.content[2] as { text: string }).text).toBe('后段')
  })
})
