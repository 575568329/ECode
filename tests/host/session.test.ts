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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHistoryStore, NoopHistoryStore, type HistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { CommandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'

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

describe('M12-P0：用量统计地基（累计器 + stats 行落盘 + MCP 计数）', () => {
  /** 捕获 appendUsageStats 的 spy store（其余 Noop） */
  function spyHistory(): { store: HistoryStore; records: Array<Record<string, unknown>> } {
    const records: Array<Record<string, unknown>> = []
    const base = new NoopHistoryStore()
    return {
      records,
      store: {
        append: (m) => base.append(m),
        appendCompactBoundary: (b) => base.appendCompactBoundary(b),
        appendRewind: (l) => base.appendRewind(l),
        appendUsageStats: (r) => {
          records.push({ ...r })
        },
        loadAll: () => base.loadAll(),
        restore: (id) => base.restore(id),
        restoreFull: (id) => base.restoreFull(id),
        setSessionId: (id, m) => base.setSessionId(id, m),
        currentSessionId: () => base.currentSessionId(),
      } as unknown as HistoryStore,
    }
  }

  it('usage 帧 → stats 行落盘（自包含 cwd/model/ts，累计器加总）', async () => {
    const p = new MockProvider([
      [
        { type: 'usage', input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_creation_tokens: 5 },
        { type: 'text', text: 'ok' },
        { type: 'done', stop_reason: 'end' },
      ],
      [
        { type: 'usage', input_tokens: 200, output_tokens: 20 },
        { type: 'text', text: 'done' },
        { type: 'done', stop_reason: 'end' },
      ],
    ])
    const h = spyHistory()
    const host = new HostSession({ ...makeDeps(p), history: h.store, cwd: 'D:/proj/x' })
    await host.send({ op: 'prompt', text: 'a', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(h.records.length).toBe(1)
    expect(h.records[0]).toMatchObject({ stats: true, cwd: 'D:/proj/x', model: 'm', input: 100, output: 10, cacheRead: 40, cacheCreation: 5 })
    await host.send({ op: 'prompt', text: 'b', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(h.records.length).toBe(2)
    expect(h.records[1]).toMatchObject({ input: 200, output: 20, cacheRead: 0 })
  })

  it('审阅 P1-1：restoreFrom 会话切换后 mcpCalls 归零（防旧累计值写进新文件致全局双计）', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({ ...echoTool, name: 'mcp__srv__search' })
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'mcp__srv__search' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [
        { type: 'usage', input_tokens: 50, output_tokens: 5 },
        { type: 'text', text: 'done' },
        { type: 'done', stop_reason: 'end' },
      ],
      [
        { type: 'usage', input_tokens: 10, output_tokens: 1 },
        { type: 'text', text: 'after' },
        { type: 'done', stop_reason: 'end' },
      ],
    ])
    const h = spyHistory()
    const host = new HostSession({ ...makeDeps(p), tools: reg, history: h.store })
    await host.send({ op: 'prompt', text: 'a', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(h.records[0]).toMatchObject({ mcpCalls: 1 })
    host.restoreFrom([]) // 会话切换（/history 恢复链路）
    await host.send({ op: 'prompt', text: 'b', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(h.records[1]).toMatchObject({ input: 10, mcpCalls: 0 }) // 新会话从 0 起
  })

  it('mcp__ 前缀工具调用计数（stats 行携带累计值）', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({ ...echoTool, name: 'mcp__srv__search' })
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 't1', name: 'mcp__srv__search' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [
        { type: 'usage', input_tokens: 50, output_tokens: 5 },
        { type: 'text', text: 'done' },
        { type: 'done', stop_reason: 'end' },
      ],
    ])
    const h = spyHistory()
    const host = new HostSession({ ...makeDeps(p), tools: reg, history: h.store })
    await host.send({ op: 'prompt', text: 'a', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ input: 50, mcpCalls: 1 })
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
    const r = await host.send({ op: 'session/read', sessionId: '2026-08-27Tx' }) // 审阅 P0-1：白名单形态
    expect(r).toMatchObject({ ok: true })
    host.dispose()
  })

  it('W9 model/set：成功改 current + config/changed 广播脱敏；config/get 同样不带 apiKey 原文', async () => {
    const deps = makeDeps(new MockProvider([]))
    ;(deps.getConfig().providers.m as { models: string[] }).models.push('m2') // 第二个模型供切换
    const host = new HostSession(deps)
    const events = collect(host)
    const bad = await host.send({ op: 'model/set', provider: 'm', model: '不存在' })
    expect(bad.ok).toBe(false)
    const good = await host.send({ op: 'model/set', provider: 'm', model: 'm2' })
    expect(good).toMatchObject({ ok: true })
    expect(deps.getConfig().current).toEqual({ name: 'm', model: 'm2' }) // 活引用生效
    const changed = events.find((e) => e.type === 'config/changed') as { config?: Record<string, unknown> } | undefined
    expect(changed?.config).toBeDefined()
    expect(JSON.stringify(changed?.config)).not.toContain('"sk"') // redact 后密钥不出通道
    const g = await host.send({ op: 'config/get' })
    expect(g.ok).toBe(true)
    expect(JSON.stringify(g.value)).not.toContain('"sk"')
    host.dispose()
  })
})

describe('中断不自动续投（Ctrl+C「无法中断」根因修复）', () => {
  it('interrupt 后轮末兜底不起队列新轮；队列保留并 systemMsg 提示', async () => {
    const gate = Promise.withResolvers<void>()
    const p = new MockProvider([[{ type: 'text', text: '挂着' }, { type: 'done', stop_reason: 'end' }]], [gate.promise])
    const host = new HostSession(makeDeps(p))
    const events = collect(host)
    await host.send({ op: 'prompt', text: '长任务', mode: 'StartOrSteer' })
    await host.send({ op: 'prompt', text: '排队的', mode: 'StartIfIdle' }) // 忙 → 入队
    await host.send({ op: 'interrupt' })
    gate.resolve()
    await host.whenIdle()
    // 只有一轮：中断后不允许队列条目立刻自动起新轮（看似模型停不下来）
    expect(events.filter((e) => e.type === 'turn/started').length).toBe(1)
    // 队列不弃（CC 同款）：systemMsg 提示保留条数，queue/snapshot 仍含条目
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('插话队列保留 1 条'))).toBe(true)
    expect(events.some((e) => e.type === 'queue/snapshot' && (e.items ?? []).includes('排队的'))).toBe(true)
  })
})

describe('M14-C1b 工具全文 summary+read 与 transcript 分页', () => {
  const bigTool: Tool = {
    name: 'bigout',
    description: 'big output',
    input_schema: { type: 'object', properties: {}, required: [] },
    readonly: true,
    async execute() {
      return { content: `B${'x'.repeat(10_000)}` } // 10KB——超 4KB 帧上限
    },
  }

  function makeBigDeps(provider: LLMProvider): HostDeps {
    const d = makeDeps(provider)
    ;(d as { tools?: ToolRegistry }).tools?.register(bigTool)
    return d
  }

  it('⑤ 超长输出：帧 content 截断 4KB + truncated 标志；item/read 返回全文', async () => {
    const p = new MockProvider([
      [
        { type: 'text', text: '跑' },
        { type: 'tool_use_start', id: 't9', name: 'bigout' },
        { type: 'tool_use_end', id: 't9' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    const host = new HostSession(makeBigDeps(p))
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    const frame = events.find((e) => e.type === 'item/completed')
    if (frame?.type !== 'item/completed') throw new Error('item/completed 未到达')
    expect(frame.truncated).toBe(true)
    expect(frame.content.length).toBe(4096)
    expect(frame.content.startsWith('B')).toBe(true)
    const read = await host.send({ op: 'item/read', itemId: frame.itemId })
    expect(read.ok).toBe(true)
    expect((read.value as { content: string }).content.length).toBe(10_001)
    host.dispose()
  })

  it('⑤ item/read：不存在的 itemId 404 语义', async () => {
    const host = new HostSession(makeDeps(new MockProvider([[{ type: 'done', stop_reason: 'end' }]])))
    const r = await host.send({ op: 'item/read', itemId: 'nope' })
    expect(r).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' })
    host.dispose()
  })

  it('F-34：内存 mirror 丢原文后 item/read fallback 到 HistoryStore 落盘行（含冷会话语义）', async () => {
    // 场景：轮完成后内存 messages 被清（模拟压缩重建/换端读旧会话——盘上有全量原文）
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 'tF34', name: 'bigout' },
        { type: 'tool_use_end', id: 'tF34' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    const deps = makeBigDeps(p)
    const sid = `2026-08-27Tf34-${Date.now()}`
    ;(deps as { history: HistoryStore }).history = new FileHistoryStore({ sessionId: sid, model: 'm', cwd: '/tmp', dir: mkdtempSync(join(tmpdir(), 'ecode-f34-')) })
    const host = new HostSession(deps)
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    // 内存源 intact 时可读（基线）
    const r1 = await host.send({ op: 'item/read', itemId: 'tF34' })
    expect(r1.ok).toBe(true)
    expect((r1.value as { content: string }).content.length).toBe(10_001)
    // 清内存 mirror（restoreFrom([])）→ 只剩盘上原文；冷会话（serve 重启）同形态
    host.restoreFrom([])
    const r2 = await host.send({ op: 'item/read', itemId: 'tF34' })
    expect(r2.ok).toBe(true)
    expect((r2.value as { content: string }).content.length).toBe(10_001)
    expect((r2.value as { content: string }).content.startsWith('B')).toBe(true)
    host.dispose()
  })

  it('①a session/read 分页：缺省全量数组；fromLine/limit 返回 { lines, total, fromLine }', async () => {
    // NoopHistoryStore.restoreFull 恒空——换真 FileHistoryStore（tmpdir）让 transcript 有行
    const deps = makeDeps(new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]]))
    const sid = `2026-08-27Tc1b-${Date.now()}` // 审阅 P0-1：ISO 白名单形态（session/read 进文件路径）
    ;(deps as { history: HistoryStore }).history = new FileHistoryStore({ sessionId: sid, model: 'm', cwd: '/tmp', dir: mkdtempSync(join(tmpdir(), 'ecode-c1b-')) })
    const host = new HostSession(deps)
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    const full = await host.send({ op: 'session/read', sessionId: sid })
    expect(Array.isArray(full.value)).toBe(true)
    expect((full.value as unknown[]).length).toBeGreaterThanOrEqual(2) // user + assistant
    const paged = await host.send({ op: 'session/read', sessionId: sid, fromLine: 0, limit: 1 })
    expect(paged.ok).toBe(true)
    const v = paged.value as { lines: unknown[]; total: number; fromLine: number }
    expect(v.lines.length).toBe(1)
    expect(v.total).toBe((full.value as unknown[]).length)
    expect(v.fromLine).toBe(0)
    host.dispose()
  })
})

describe('M14-C3③（P1-12）：带图 prompt 并发双发不开双轮', () => {
  function png1x1(): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const len = Buffer.from([0, 0, 0, 13])
    const ihdr = Buffer.from('IHDR')
    const data = Buffer.alloc(13)
    data.writeUInt32BE(1, 0)
    data.writeUInt32BE(1, 4)
    return Buffer.concat([sig, len, ihdr, data, Buffer.alloc(4)])
  }

  it('两个带图 prompt 同步连发：starting 同步占位堵 buildBlocks await 窗口——turn 严格串行（started/completed 交替）且 whenIdle 收敛不滞留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-p1-12-'))
    const imgPath = join(dir, 'p.png')
    writeFileSync(imgPath, png1x1())
    const p = new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]])
    const host = new HostSession(makeDeps(p))
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))
    // 同步连发（send 同步进 dispatch）：第一条在 buildBlocks 的 readFile await 处挂起时
    // 第二条到达 running 检查——修复前两者都过检查并发双开轮（同时两个 turn/started），
    // 修复后第二条被 starting 占位挡下（Steered 插话或轮已结束转 Started 顺序开轮）
    const [r1, r2] = await Promise.all([
      host.send({ op: 'prompt', text: '第一张图', mode: 'StartOrSteer', images: [{ path: imgPath, mime: 'image/png' }] }),
      host.send({ op: 'prompt', text: '第二张图', mode: 'StartOrSteer', images: [{ path: imgPath, mime: 'image/png' }] }),
    ])
    expect(r1).toMatchObject({ ok: true, routed: 'Started' })
    expect(r2).toMatchObject({ ok: true })
    await host.whenIdle() // 滞留竞态回归哨兵：busy 判定过时若只入队不复查，此处死等超时
    // 串行性：started/completed 严格交替（任意前缀 started 计数 ≥ completed 且差 ≤ 1）
    let open = 0
    let maxOverlap = 0
    for (const e of events) {
      if (e.type === 'turn/started') maxOverlap = Math.max(maxOverlap, ++open)
      if (e.type === 'turn/completed') open--
    }
    expect(maxOverlap).toBe(1)
    // 两条输入都被消费（顺序两轮）
    expect(events.filter((e) => e.type === 'turn/started').length).toBe(2)
    host.dispose()
  })

  it('startTurn 配置不完整早退：starting 占位不泄漏（后续 prompt 仍可正常开轮）+ whenIdle 不死等', async () => {
    const deps = makeDeps(new MockProvider([[{ type: 'done', stop_reason: 'end' }]]))
    // 构造 provider 名缺失：providers 里删掉 current 指向的条目
    const broken = {
      ...deps,
      getConfig: () => {
        const c = deps.getConfig()
        return { ...c, current: { name: 'missing', model: 'x' } }
      },
    } as HostDeps
    const host = new HostSession(broken)
    const imgPath = join(mkdtempSync(join(tmpdir(), 'ecode-p1-12b-')), 'p.png')
    writeFileSync(imgPath, png1x1())
    const r1 = await host.send({ op: 'prompt', text: '带图开轮', mode: 'StartOrSteer', images: [{ path: imgPath, mime: 'image/png' }] })
    expect(r1).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle() // 早退路径 notifyIdle——不死等
    // 占位已清：无图 prompt 立即再开轮（而非被误判 busy 入队）
    const r2 = await host.send({ op: 'prompt', text: '再来', mode: 'StartOrSteer' })
    expect(r2).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
    host.dispose()
  })
})

// —— F-23：serve/web 端斜杠命令分流（绝不落入 LLM）——
// 清账批 III：提到模块级（清账 III 新增 describe 也复用）
const makeCmdDeps = (provider: LLMProvider): HostDeps => {
  const deps = makeDeps(provider)
  const reg = new CommandRegistry()
  registerBuiltinCommands(reg)
  return { ...deps, commands: reg }
}

describe('F-23：斜杠命令分流（prompt 前置命令拦截）', () => {
  it('host 命令（/help）：直接执行返回输出，不起 LLM 轮', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '/help', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    if (r.ok && 'routed' in r) expect(r.routed).toBe('Command')
    expect((r as { output?: string }).output).toContain('/help')
    // 未进 LLM：无 turn/started；systemMsg 帧带回执
    await new Promise((res) => setTimeout(res, 20))
    expect(events.some((e) => e.type === 'turn/started')).toBe(false)
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('/help'))).toBe(true)
    host.dispose()
  })

  it('TUI 专属命令（/model）：明确拒绝，不起 LLM 轮', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '/model', mode: 'StartOrSteer' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('TUI')
    await new Promise((res) => setTimeout(res, 20))
    expect(events.some((e) => e.type === 'turn/started')).toBe(false)
    expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('TUI'))).toBe(true)
    host.dispose()
  })

  it('未知名（/nope）：明确拒绝（与 TUI 行为一致），不起 LLM 轮', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const r = await host.send({ op: 'prompt', text: '/nope', mode: 'StartOrSteer' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('未知命令')
    await new Promise((res) => setTimeout(res, 20))
    host.dispose()
  })

  it('回归：非斜杠正常 prompt 不受分流影响（仍开 LLM 轮）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]])))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '正常问题', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
    expect(events.some((e) => e.type === 'turn/started')).toBe(true)
    host.dispose()
  })

  it('回归：未注册命令面（deps.commands 缺省）——斜杠输入走原 prompt 路径（argv/旧装配兼容）', async () => {
    const host = new HostSession(makeDeps(new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]])))
    const r = await host.send({ op: 'prompt', text: '/help', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' }) // 不分流=原行为（当作 prompt）
    await host.whenIdle()
    host.dispose()
  })
})

// —— 清账批 III（P1-2 已被 F-33 翻案：沙箱随时可切）——
describe('F-33：sandbox/set 运行中切档（翻案清账 III P1-2 的 BUSY 拒绝）', () => {
  it('busy 中切档成功且后续工具的 checkWrite 与 hostConfirm 都按新档口径（无口径分裂）', async () => {
    // 轮挂起在审批上（bash 工具无订阅者可答 → fail-closed 等待）= running=true 的稳定窗口；
    // 切到 read-only 后应答审批 → bash 的 checkBash 按新档 deny（read-only 整体拒）。
    // 工具侧 ctx.sandbox 是访问器属性（读时实时 makeSandbox）——这就是 getter 方案的核心保证。
    const reg = new ToolRegistryImpl()
    let executed = false
    reg.register({
      name: 'bash',
      description: 'bash',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      readonly: false,
      async execute(args, ctx) {
        executed = true
        const gate = ctx.sandbox?.checkBash(String((args as { command: string }).command))
        if (gate !== undefined && gate.action === 'deny') return { content: gate.reason, is_error: true }
        return { content: 'ok' }
      },
    })
    const host = new HostSession({
      ...makeCmdDeps(new MockProvider([
        [
          { type: 'tool_use_start', id: 'b1', name: 'bash' },
          { type: 'tool_use_delta', id: 'b1', partial_json: '{"command":"ls"}' },
          { type: 'tool_use_end', id: 'b1' },
          { type: 'done', stop_reason: 'tool_use' },
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stop_reason: 'end' }],
      ])),
      tools: reg,
    } as HostDeps)
    const events = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    for (let i = 0; i < 40 && !events.some((e) => e.type === 'approval/requested'); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    // 审批挂起中 = 轮运行中：切档立即成功（不再 BUSY 拒）
    const r = await host.send({ op: 'sandbox/set', mode: 'read-only' })
    expect(r.ok).toBe(true)
    // 应答审批（放行）→ 工具读 ctx.sandbox 应按新档 read-only：checkBash deny（口径一致）
    const req = events.find((e) => e.type === 'approval/requested')
    expect(req).toBeDefined()
    await host.send({ op: 'approval/respond', requestId: (req as { requestId: string }).requestId, decision: 'allow' })
    await host.whenIdle()
    expect(executed).toBe(true)
    const completed = events.find((e) => e.type === 'item/completed' && (e as { name?: string }).name === 'bash')
    expect(completed).toBeDefined()
    expect((completed as { content?: string }).content).toContain('read-only')
    host.dispose()
  })

  it('空闲时 sandbox/set 照常生效（守卫不误伤）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const r = await host.send({ op: 'sandbox/set', mode: 'read-only' })
    expect(r.ok).toBe(true)
    host.dispose()
  })
})

describe('清账 III P1-3：/clear 分流发布 session/clear 事件', () => {
  it('serve 端 /clear 除 notice 外还发 session/clear（web 视图同步）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '/clear', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    await new Promise((res) => setTimeout(res, 20))
    expect(events.some((e) => e.type === 'session/clear')).toBe(true)
    host.dispose()
  })
})

describe('清账 III P2-6/P2-7：裸 / 口径与 serve 端 /help 过滤', () => {
  it('裸 "/"（整条输入）被拦为未知命令，不落 LLM', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    const r = await host.send({ op: 'prompt', text: '/', mode: 'StartOrSteer' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SLASH_COMMAND_TUI_ONLY')
    await new Promise((res) => setTimeout(res, 20))
    expect(events.some((e) => e.type === 'turn/started')).toBe(false)
    host.dispose()
  })

  it('普通文本含 /（如 "a/b 或 /path"）不受影响——仍走 prompt 路径', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([[{ type: 'text', text: 'ok' }, { type: 'done', stop_reason: 'end' }]])))
    const r = await host.send({ op: 'prompt', text: '帮我看看 /api/cmd 路由', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
    await host.whenIdle()
    host.dispose()
  })

  it('P2-7：serve 端 /help 只列 host 可执行五命令 + 客户端提示', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const r = await host.send({ op: 'prompt', text: '/help', mode: 'StartOrSteer' })
    expect(r.ok).toBe(true)
    const out = (r as { output?: string }).output ?? ''
    expect(out).toContain('/stats')
    expect(out).toContain('/cost')
    expect(out).toContain('/clear')
    expect(out).toContain('/compact')
    expect(out).toContain('客户端')
    // TUI 面板命令不列（serve 履约不了）
    expect(out).not.toContain('/model')
    expect(out).not.toContain('/skill')
    host.dispose()
  })
})
