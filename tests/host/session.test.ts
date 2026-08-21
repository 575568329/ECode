/**
 * M12-B1 宿主会话测试：事件序/seq 单调、prompt 三态路由（StartOrSteer/StartIfIdle/Steer 防竞态）、
 * interrupt、轮末兜底续投。MockProvider 模式与 tests/core/loop.test.ts 同源。
 */
import { describe, expect, it } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class MockProvider implements LLMProvider {
  readonly type = 'mock'
  private call = 0
  constructor(
    private readonly script: Delta[][],
    private readonly gate?: Array<Promise<void>>,
  ) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const gate = this.gate?.[this.call]
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) {
      if (d.type === 'text' && gate !== undefined) await gate // 忙窗：吐首 delta 前挂起
      yield d
    }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const echoTool: Tool = {
  name: 'echo',
  description: 'echo',
  // required 放空：mock 脚本的 tool_use delta 不带 input，required 校验失败会走 loop 的
  // 静默早退路径（invokeTool 校验失败不触发 onToolResult——已记录为 loop 回调盲区，B3 收口）
  input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
  readonly: true,
  async execute() {
    return { content: 'ok' }
  },
}

function makeDeps(provider: LLMProvider): HostDeps {
  const reg = new ToolRegistryImpl()
  reg.register(echoTool)
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: {
      m: {
        type: 'mock',
        baseURL: 'http://x',
        apiKey: 'sk',
        models: ['m'],
        contextWindow: 32000, // 跳过 models.dev 联网解析（测试离线确定性）
      },
    },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  return {
    providerRegistry: { getByType: () => provider } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator,
    skillListForPrompt: () => [],
  }
}

const collect = (host: HostSession): ProtocolEvent[] => {
  const events: ProtocolEvent[] = []
  host.subscribe((e) => events.push(e))
  return events
}

describe('HostSession（B1 宿主会话）', () => {
  it('事件序：turn/started → delta → item/* → usage → turn/completed；seq 单调', async () => {
    const p = new MockProvider([
      [
        { type: 'text', text: '你好' },
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    const host = new HostSession(makeDeps(p))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
    const types = events.map((e) => e.type)
    expect(types).toContain('turn/started')
    expect(types).toContain('delta')
    expect(types).toContain('item/started')
    expect(types).toContain('item/completed')
    expect(types.indexOf('turn/completed')).toBeGreaterThan(types.indexOf('item/completed'))
    const seqs = events.map((e) => e.seq)
    expect(JSON.stringify(seqs)).toBe(JSON.stringify([...seqs].sort((a, b) => a - b)))
  })

  it('busy 三态：StartOrSteer=Steered（步间注入）；StartIfIdle=Queued（轮末续投）；Steer 轮 id 不符=Rejected', async () => {
    // 轮一跨两个迭代（A: 文本+工具 → done tool_use；B: 收尾）——pollUserInput 在迭代顶部拉取，
    // 单迭代轮永远到不了注入点（首版脚本的单文本轮即败于此）
    const g1 = Promise.withResolvers<void>()
    const g2 = Promise.withResolvers<void>()
    const p = new MockProvider(
      [
        [
          { type: 'text', text: '第一轮' },
          { type: 'tool_use_start', id: 't1', name: 'echo' },
          { type: 'tool_use_end', id: 't1' },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [{ type: 'text', text: '收尾' }, { type: 'done', stop_reason: 'end' }],
        [{ type: 'text', text: '第三轮' }, { type: 'done', stop_reason: 'end' }],
      ],
      [g1.promise, g2.promise, undefined],
    )
    const host = new HostSession(makeDeps(p))
    const events = collect(host)
    await host.send({ op: 'prompt', text: '一', mode: 'StartOrSteer' })
    const steered = await host.send({ op: 'prompt', text: '二', mode: 'StartOrSteer' }) // 忙 → Steered
    expect(steered).toMatchObject({ ok: true, routed: 'Steered' })
    const q = await host.send({ op: 'prompt', text: '三', mode: 'StartIfIdle' }) // 忙 → Queued
    expect(q).toMatchObject({ ok: true, routed: 'Queued' })
    const rej = await host.send({ op: 'prompt', text: 'x', mode: { Steer: { expectedTurnId: '不存在' } } })
    expect(rej).toMatchObject({ ok: true, routed: 'Rejected' })
    g1.resolve()
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.type === 'interjection/enqueued')).toBe(true)
    g2.resolve()
    await host.whenIdle()
    expect(events.some((e) => e.type === 'interjection/injected' && e.text === '二')).toBe(true)
    expect(events.filter((e) => e.type === 'turn/started').length).toBe(2) // 轮一（含注入二）+ 轮末兜底三
  })

  it('interrupt：中断当前轮并收敛（turn/completed 仍发布）', async () => {
    const gate = Promise.withResolvers<void>()
    const p = new MockProvider([[{ type: 'text', text: '挂着' }, { type: 'done', stop_reason: 'end' }]], [gate.promise])
    const host = new HostSession(makeDeps(p))
    const events = collect(host)
    await host.send({ op: 'prompt', text: '长任务', mode: 'StartOrSteer' })
    await host.send({ op: 'interrupt' })
    gate.resolve()
    await host.whenIdle()
    expect(events.some((e) => e.type === 'turn/completed')).toBe(true)
    expect(events.some((e) => e.type === 'thread/status' && e.busy === false)).toBe(true)
  })

  it('未接线命令回执 NOT_IMPLEMENTED（B2/B5 接线前不装死）', async () => {
    const host = new HostSession(makeDeps(new MockProvider([])))
    const r = await host.send({ op: 'command/exec', name: '不存在' })
    expect(r).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' })
  })

  it('B2 集成：非 readonly 工具经 Broker——订阅者 respond once 放行；零订阅者 fail-closed 拒绝', async () => {
    const writeTool: Tool = {
      name: 'write_file',
      description: 'write',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: false,
      async execute() {
        return { content: 'wrote' }
      },
    }
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 't1', name: 'write_file' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
    ]
    // 场景 1：订阅者自动应答 once → 工具执行成功
    {
      const reg = new ToolRegistryImpl()
      reg.register(writeTool)
      const deps = { ...makeDeps(new MockProvider(script)), tools: reg }
      const host = new HostSession(deps)
      const events: ProtocolEvent[] = []
      host.subscribe((e) => {
        events.push(e)
        if (e.type === 'approval/requested') void host.send({ op: 'approval/respond', requestId: e.requestId, decision: 'once' })
      })
      await host.send({ op: 'prompt', text: '写', mode: 'StartOrSteer' })
      await host.whenIdle()
      const done = events.find((e) => e.type === 'item/completed' && e.name === 'write_file')
      expect(done).toMatchObject({ isError: false, summary: 'wrote' })
    }
    // 场景 2：订阅者 respond reject → 工具被拒（is_error，'用户已取消'）
    {
      const reg = new ToolRegistryImpl()
      reg.register(writeTool)
      const host = new HostSession({ ...makeDeps(new MockProvider(script)), tools: reg })
      const events: ProtocolEvent[] = []
      host.subscribe((e) => {
        events.push(e)
        if (e.type === 'approval/requested') void host.send({ op: 'approval/respond', requestId: e.requestId, decision: 'reject' })
      })
      await host.send({ op: 'prompt', text: '写', mode: 'StartOrSteer' })
      await host.whenIdle()
      const done = events.find((e) => e.type === 'item/completed' && e.name === 'write_file')
      expect(done).toMatchObject({ isError: true })
      host.dispose()
    }
    // 零订阅者 fail-closed 的 Broker 单元语义已由 approval.test 覆盖（confirm → false）
  })
})

describe('B4 验收：双 HostSession 互不串台（D5 会话级状态）', () => {
  it('子代理进度按会话隔离：各自 updateSubagent 只进自己的事件流', () => {
    const h1 = new HostSession(makeDeps(new MockProvider([])))
    const h2 = new HostSession(makeDeps(new MockProvider([])))
    const e1: ProtocolEvent[] = []
    const e2: ProtocolEvent[] = []
    h1.subscribe((e) => e1.push(e))
    h2.subscribe((e) => e2.push(e))
    h1.updateSubagent({ id: 'a1', description: '会话一任务', activity: '启动中' })
    h2.updateSubagent({ id: 'a2', description: '会话二任务', activity: '启动中' })
    const p1 = e1.filter((e) => e.type === 'subagent/progress')
    const p2 = e2.filter((e) => e.type === 'subagent/progress')
    expect(p1.every((e) => (e as { agents: { id: string }[] }).agents.every((a) => a.id === 'a1'))).toBe(true)
    expect(p2.every((e) => (e as { agents: { id: string }[] }).agents.every((a) => a.id === 'a2'))).toBe(true)
    h1.removeSubagent('a1')
    const last1 = e1.filter((e) => e.type === 'subagent/progress').at(-1) as { agents: { id: string }[] }
    expect(last1.agents).toHaveLength(0)
    h1.dispose()
    h2.dispose()
  })

  it('toolCtx 携带会话级 tasks（bash run_in_background 类任务表隔离；结构存在性断言）', async () => {
    const host = new HostSession(makeDeps(new MockProvider([])))
    let seen: unknown = null
    ;(host as unknown as { channel: { bind(d: unknown): void } }).channel // channel 私有——经公开路径验证：
    // 用一个非 readonly 探针工具走完整轮，execute 里断言 ctx.tasks/ctx.session 存在
    const probe: Tool = {
      name: 'write_probe',
      description: 'probe',
      input_schema: { type: 'object', properties: {}, required: [] },
      readonly: false,
      async execute(_args, ctx) {
        seen = { tasks: ctx.tasks !== undefined, session: ctx.session !== undefined }
        return { content: 'ok' }
      },
    }
    const reg = new ToolRegistryImpl()
    reg.register(probe)
    const h = new HostSession({ ...makeDeps(new MockProvider([
      [
        { type: 'tool_use_start', id: 't9', name: 'write_probe' },
        { type: 'tool_use_end', id: 't9' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])), tools: reg })
    h.subscribe((e) => {
      if (e.type === 'approval/requested') void h.send({ op: 'approval/respond', requestId: e.requestId, decision: 'once' })
    })
    await h.send({ op: 'prompt', text: '跑探针', mode: 'StartOrSteer' })
    await h.whenIdle()
    expect(seen).toEqual({ tasks: true, session: true })
    h.dispose()
    host.dispose()
  })
})

describe('B5：session 命令面', () => {
  it('session/clear 清宿主 messages；session/list·read 经 history', async () => {
    const deps = makeDeps(new MockProvider([[{ type: 'text', text: '一轮' }, { type: 'done', stop_reason: 'end' }]]))
    const host = new HostSession(deps)
    await host.send({ op: 'prompt', text: 'hi', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(host.transcript.length).toBeGreaterThan(0)
    const c = await host.send({ op: 'session/clear' })
    expect(c).toMatchObject({ ok: true })
    expect(host.transcript).toHaveLength(0)
    // list/read 走 deps.history（fake noopHistory：loadAll 返回 []——真实 FileHistoryStore 行为由既有 history 测试锁定）
    const l = await host.send({ op: 'session/list' })
    expect(l).toMatchObject({ ok: true })
    const r = await host.send({ op: 'session/read', sessionId: 'x' })
    expect(r).toMatchObject({ ok: true })
    host.dispose()
  })
})
