/**
 * D9 回归（2026-08-31 走查）：并行只读批次里两张 sensitive 卡同时挂起——
 * TUI 审批卡单槽，后帧顶掉前帧且不再渲染，未应答挂起悬空至审批超时（900s 假死）。
 * 修复语义：
 *   1. 宿主级串行化（enqueueConfirm）——第二张卡在第一张 resolved 之前不得发布 requested；
 *   2. 中断收敛——broker 挂起接受当轮 abort signal，interrupt 即 fail-closed 收敛（不等超时）。
 */
import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class MockProvider implements LLMProvider {
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(req: LLMProviderRunRequest): AsyncIterable<Delta> {
    // 保真：真实 provider 流在 signal 中止时终止——mock 同样不再产 delta
    if (req.signal?.aborted === true) return
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** 触发 sensitive 卡的只读探针工具（confirmSensitive 由宿主 onSensitiveAccess 透传） */
const sensTool = (name: string): Tool => ({
  name,
  description: `sensitive probe ${name}`,
  input_schema: { type: 'object', properties: {}, required: [] },
  readonly: true,
  async execute(_input, ctx) {
    const ok = await ctx.confirmSensitive?.(`读取敏感路径 ${name}`)
    return ok === true ? { content: 'allowed' } : { content: 'denied', isError: true }
  },
})

function makeHost(script: Delta[][]): { host: HostSession; events: ProtocolEvent[] } {
  const reg = new ToolRegistryImpl()
  reg.register(sensTool('readA'))
  reg.register(sensTool('readB'))
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: {
      m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 },
    },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  const provider = new MockProvider(script)
  const host = new HostSession({
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
    cwd: mkdtempSync(join(tmpdir(), 'ecode-d9-')),
  })
  const events: ProtocolEvent[] = []
  host.subscribe((e) => events.push(e))
  return { host, events }
}

const waitFor = (fn: () => boolean, ms = 3000): Promise<boolean> =>
  new Promise((r) => {
    const t0 = Date.now()
    const id = setInterval(() => {
      if (fn() || Date.now() - t0 > ms) {
        clearInterval(id)
        r(fn())
      }
    }, 20)
  })

describe('D9 敏感卡串行化与中断收敛', () => {
  it('并行批次两张 sensitive 卡串行发布：第二张 requested 在第一张 resolved 之后', async () => {
    const { host, events } = makeHost([
      [
        { type: 'tool_use_start', id: 'a1', name: 'readA' },
        { type: 'tool_use_end', id: 'a1' },
        { type: 'tool_use_start', id: 'b1', name: 'readB' },
        { type: 'tool_use_end', id: 'b1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    await host.send({ op: 'prompt', text: '查', mode: 'StartOrSteer' })
    expect(
      await waitFor(() => events.filter((e) => e.type === 'approval/requested').length >= 1),
    ).toBe(true)
    const [r1] = events.filter((e) => e.type === 'approval/requested') as Array<{ requestId: string; seq: number }>
    // 第一张卡挂起期间：不得有第二张 requested（串行化核心断言）
    expect(events.filter((e) => e.type === 'approval/requested')).toHaveLength(1)
    const ack = await host.send({ op: 'approval/respond', requestId: r1.requestId, decision: 'once' })
    expect(ack.ok).toBe(true)
    expect(await waitFor(() => events.filter((e) => e.type === 'approval/requested').length >= 2)).toBe(true)
    const [r2] = events.filter((e) => e.type === 'approval/requested').slice(1) as Array<{ requestId: string; seq: number }>
    const resolved1 = events.find((e) => e.type === 'approval/resolved' && (e as { requestId: string }).requestId === r1.requestId) as { seq: number }
    expect(r2.seq).toBeGreaterThan(resolved1.seq)
    await host.send({ op: 'approval/respond', requestId: r2.requestId, decision: 'once' })
    await host.whenIdle()
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
    // 两张卡都放行：两个工具都执行成功
    const toolDone = events.filter((e) => e.type === 'item/completed' && !('isError' in e && e.isError === true))
    expect(toolDone.length).toBeGreaterThanOrEqual(2)
  }, 8000)

  it('中断收敛：卡挂起时 interrupt 立即 fail-closed 收敛，轮终止不悬空', async () => {
    const { host, events } = makeHost([
      [
        { type: 'tool_use_start', id: 'a1', name: 'readA' },
        { type: 'tool_use_end', id: 'a1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ])
    await host.send({ op: 'prompt', text: '查', mode: 'StartOrSteer' })
    expect(await waitFor(() => events.some((e) => e.type === 'approval/requested'))).toBe(true)
    const r = await host.send({ op: 'interrupt' })
    expect(r.ok).toBe(true)
    // 中断后轮必须终止（不依赖审批超时）——whenIdle 在 3s 内解决；
    // race 输家的 reject 须清定时器防 unhandledRejection（审阅批卫生项）
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        host.whenIdle(),
        new Promise((_resolve, rej) => {
          timer = setTimeout(() => rej(new Error('interrupt 未收敛')), 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    const resolved = events.find((e) => e.type === 'approval/resolved') as { outcome: string }
    expect(resolved).toBeDefined()
    expect(resolved.outcome).toBe('cancelled')
  }, 8000)

  it('排队卡中断不落卡：第二张敏感卡随中断收敛（requested 必有配对 resolved，无孤儿挂起）', async () => {
    const { host, events } = makeHost([
      [
        { type: 'tool_use_start', id: 'a1', name: 'readA' },
        { type: 'tool_use_end', id: 'a1' },
        { type: 'tool_use_start', id: 'b1', name: 'readB' },
        { type: 'tool_use_end', id: 'b1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    await host.send({ op: 'prompt', text: '查', mode: 'StartOrSteer' })
    expect(await waitFor(() => events.some((e) => e.type === 'approval/requested'))).toBe(true)
    // 不应答第一张，直接中断——第二张在队列中，收敛面二选一：出队时 aborted 快拒或挂起即收敛
    const r = await host.send({ op: 'interrupt' })
    expect(r.ok).toBe(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        host.whenIdle(),
        new Promise((_resolve, rej) => {
          timer = setTimeout(() => rej(new Error('interrupt 未收敛（排队卡悬空）')), 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    // 无孤儿挂起：每个 requested 都有配对 resolved（无「顶掉后永不渲染也不收敛」形态）
    const requested = events.filter((e) => e.type === 'approval/requested')
    for (const req of requested) {
      const id = (req as { requestId: string }).requestId
      expect(events.some((e) => e.type === 'approval/resolved' && (e as { requestId: string }).requestId === id)).toBe(true)
    }
    // 中断后轮直接 unwind（不会进 mock 第二轮）——round-2 文本不得出现；工具级完成帧
    // 在中断路径无 isError 标记，不作断言（避免钉死帧形态）
    expect(events.some((e) => e.type === 'delta' && e.text === '完成')).toBe(false)
  }, 8000)
})
