/**
 * M12-B1 宿主会话测试：事件序/seq 单调、prompt 三态路由（StartOrSteer/StartIfIdle/Steer 防竞态）、
 * interrupt、轮末兜底续投。MockProvider 模式与 tests/core/loop.test.ts 同源。
 */
import { describe, expect, it, vi } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { ProtocolEvent, RewindExecResult, RewindListResult } from '../../src/protocol/types.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta, RewindLine } from '../../src/core/types.js'
import { CheckpointStore } from '../../src/services/checkpoint.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { Logger } from '../../src/services/logger.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('未接线命令回执 NOT_IMPLEMENTED（接线前不装死）', async () => {
    const host = new HostSession(makeDeps(new MockProvider([])))
    const r = await host.send({ op: 'no/such-op' } as never)
    expect(r).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' })
  })

  it('T1：session/compact 触发压缩链，完成后 systemMsg 通知（空会话=失败分支接线验证）', async () => {
    const host = new HostSession(makeDeps(new MockProvider([])))
    const events = collect(host)
    const r = await host.send({ op: 'session/compact' })
    expect(r).toMatchObject({ ok: true, output: expect.stringContaining('压缩已开始') })
    // 空会话 → compactManual 快速失败 → systemMsg「压缩失败：无可压缩对话」（真压缩链自有测试覆盖）
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('压缩失败'))).toBe(true)
    })
  })

  it('T1b：session/compact 短对话全在保留区 → 如实报失败（manual 门槛+谎报成功双修复回归）', async () => {
    // 修复前：hook 条件漏 manual（未超阈零操作）+ compactManual 恒 {ok:true} → 谎报「压缩完成」。
    // 修复后：manual 必进压缩分支，两条小消息全在 RECENT_BUDGET(8000) 保留区 → boundary 零新增 →
    // 如实 {ok:false}。messages 经真实 prompt 轮次注入（两条小消息 ≈ 数 token，远小于保留区）
    const host = new HostSession(makeDeps(new MockProvider([[{ type: 'text', text: '好' }, { type: 'done', stop_reason: 'end' }]])))
    const events = collect(host)
    await host.send({ op: 'prompt', text: '你好', mode: 'StartOrSteer' })
    await host.whenIdle()
    const r = await host.send({ op: 'session/compact' })
    expect(r).toMatchObject({ ok: true, output: expect.stringContaining('压缩已开始') })
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'systemMsg' && e.text.includes('压缩失败：无可压缩内容'))).toBe(true)
    })
    expect(events.some((e) => e.type === 'compacted')).toBe(false) // 零操作不得发 compacted 帧
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

  it('D-T8 集成：审批超时 → tool_result 如实「审批超时」引导模型决策（不得谎称用户拒绝）', async () => {
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
      [{ type: 'text', text: '已记录待办' }, { type: 'done', stop_reason: 'end' }],
    ]
    const reg = new ToolRegistryImpl()
    reg.register(writeTool)
    const config = makeDeps(new MockProvider(script))
    // 短超时触发 timeoutResolve（宿主注入 config.approvalTimeoutMs → broker）
    const host = new HostSession({
      ...config,
      tools: reg,
      getConfig: () => ({ ...config.getConfig(), approvalTimeoutMs: 40 }),
    })
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e)) // 有订阅者（否则 fail-closed 先收敛，测不到超时）
    await host.send({ op: 'prompt', text: '写', mode: 'StartOrSteer' })
    await host.whenIdle()
    const done = events.find((e) => e.type === 'item/completed' && e.name === 'write_file')
    expect(done).toMatchObject({ isError: true })
    expect(done?.summary).toContain('审批超时')
    expect(done?.summary).not.toContain('用户拒绝')
    expect(done?.summary).not.toContain('用户已取消')
    host.dispose()
  })

  it('T1 契约：rewind/list+exec 宿主接线——列表预计算/文件还原/留痕/applied 帧/BUSY 守卫', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ecode-rewind-'))
    const work = join(tmp, 'work')
    mkdirSync(work, { recursive: true })
    const file = join(work, 'a.txt')
    writeFileSync(file, 'v1')
    const cp = new CheckpointStore(work, { rootDir: join(tmp, 'cps') })
    const SID = 'rew-test'
    const rewindLines: RewindLine[] = []
    const history: HistoryStore = {
      ...new NoopHistoryStore(),
      currentSessionId: () => SID,
      appendRewind: (l) => rewindLines.push(l),
    }
    await cp.snapshot(SID, [file], { tool: 'write_file', messageId: 'm1' })
    writeFileSync(file, 'v2') // 外部修改（快照基线之后）

    const host = new HostSession({ ...makeDeps(new MockProvider([])), checkpoint: cp, history })
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))

    // list：快照 + 外部修改宿主预计算（externallyChanged 免客户端二次往返）
    const lr = await host.send({ op: 'rewind/list' })
    expect(lr.ok).toBe(true)
    const list = lr.value as unknown as RewindListResult
    expect(list.sessionId).toBe(SID)
    expect(list.snapshots).toHaveLength(1)
    expect(list.snapshots[0]).toMatchObject({ seq: 1, tool: 'write_file', messageId: 'm1', externallyChanged: [file] })

    // exec：文件还原 v1 + 宿主留痕（transcript 镜像+history）+ applied 帧
    const er = await host.send({ op: 'rewind/exec', target: 1 })
    expect(er.ok).toBe(true)
    expect(er.value as unknown as RewindExecResult).toMatchObject({ restored: [file] })
    expect(readFileSync(file, 'utf8')).toBe('v1')
    expect(rewindLines).toHaveLength(1)
    expect(host.transcript.at(-1)).toMatchObject({ rewind: true, seq: 1, toolUseId: 'm1' })
    expect(events.some((e) => e.type === 'rewind/applied' && e.seq === 1 && e.toolUseId === 'm1')).toBe(true)

    // BUSY：轮运行中 exec 被拒
    const gate = Promise.withResolvers<void>()
    const host2 = new HostSession({
      ...makeDeps(new MockProvider([[{ type: 'text', text: '挂着' }, { type: 'done', stop_reason: 'end' }]], [gate.promise])),
      checkpoint: cp,
      history,
    })
    await host2.send({ op: 'prompt', text: '长任务', mode: 'StartOrSteer' })
    const br = await host2.send({ op: 'rewind/exec', target: 1 })
    expect(br).toMatchObject({ ok: false, code: 'BUSY' })
    gate.resolve()
    await host2.whenIdle()
    host.dispose()
    host2.dispose()
  })

  it('T 线②：session/restore fork:true 宿主化——回执新 sid/新文件播种/SessionStart(resume) 宿主 dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-fork-'))
    const oldId = '2026-08-31T00-00-00-000Z-fork-old'
    const history = new FileHistoryStore({ sessionId: oldId, model: 'm', cwd: '/tmp', dir })
    history.append({ role: 'user', content: [{ type: 'text', text: '旧会话内容' }] })

    const host = new HostSession({
      ...makeDeps(new MockProvider([])),
      history,
      cwd: '/tmp',
      ensureConversation: (sid) => Promise.resolve({ ok: true, value: { sessionId: sid } }),
    })
    // 模拟 ensure 载入（stub 不真正 restoreFrom——宿主内手动载入，测 fork 分支本身）
    host.restoreFrom(history.restoreFull(oldId))
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))

    const r = await host.send({ op: 'session/restore', sessionId: oldId, fork: true })
    expect(r.ok).toBe(true)
    const newId = (r.value as { sessionId: string }).sessionId
    expect(newId).not.toBe(oldId)
    expect(history.currentSessionId()).toBe(newId)
    // 播种：flush 后新文件含旧会话内容（fork 自包含——重开不丢前文）
    history.flushPendingSeed()
    const seeded = new FileHistoryStore({ sessionId: newId, model: 'm', cwd: '/tmp', dir }).restoreFull(newId)
    expect(seeded.some((l) => !('rewind' in l) && !('compact_boundary' in l) && JSON.stringify(l).includes('旧会话内容'))).toBe(true)
    host.dispose()
  })

  it('T1：panel/data skill+mcp 回执 / mcp/action 写动作 / mcp/approve 批准门 / startupWarnings 转 notice', async () => {
    const approvedFiles: string[] = []
    let closedServers: string[] = []
    const host = new HostSession({
      ...makeDeps(new MockProvider([])),
      startupWarnings: ['mcp 配置告警甲', '指令文件告警乙'],
      panelData: {
        skill: () => ({
          skills: [{ name: 'demo', description: '演示', source: 'user', userInvocable: true, disableModelInvocation: false }],
          shadowedCount: 1,
        }),
        mcp: () => ({
          servers: [{ name: 'srv1', status: 'ready', source: 'user', type: 'stdio', toolCount: 2 }],
          tools: { srv1: [{ name: 'srv1_t1', description: '工具一' }] },
        }),
        mcpAction: async (action, server) => {
          if (action === 'close') {
            closedServers.push(server)
            return { ok: true, output: `已关闭：${server}` }
          }
          return { ok: false, error: '连接失败' }
        },
        approveMcp: async (file, approved) => {
          if (approved) approvedFiles.push(file)
        },
      },
    })
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))

    // ⑪ 构造告警 → notice 帧
    expect(events.some((e) => e.type === 'notice' && e.text === 'mcp 配置告警甲')).toBe(true)

    // panel/data 两面板 View
    const sk = await host.send({ op: 'panel/data', panel: 'skill' })
    expect(sk.value).toMatchObject({ shadowedCount: 1, skills: [{ name: 'demo' }] })
    const mc = await host.send({ op: 'panel/data', panel: 'mcp' })
    expect(mc.value).toMatchObject({ servers: [{ name: 'srv1', status: 'ready' }] })

    // 2026-09-03：tasks 面板（attach 态客户端单例查不到 daemon 任务——协议快照数据源）
    const tk = await host.send({ op: 'panel/data', panel: 'tasks' })
    expect(tk.ok).toBe(true)
    expect(Array.isArray(tk.value)).toBe(true)

    // mcp/action：close 成功带 output；reconnect 失败收敛 ok:false
    const closed = await host.send({ op: 'mcp/action', action: 'close', server: 'srv1' })
    expect(closed).toMatchObject({ ok: true, output: '已关闭：srv1' })
    expect(closedServers).toEqual(['srv1'])
    const fail = await host.send({ op: 'mcp/action', action: 'reconnect', server: 'srv1' })
    expect(fail).toMatchObject({ ok: false, code: 'MCP_ACTION_FAILED' })

    // mcp/approve：批准二段接入 + 拒绝不接入，均 ok 回执
    const ap = await host.send({ op: 'mcp/approve', file: '/p/.mcp.json', approved: true })
    expect(ap).toMatchObject({ ok: true })
    expect(approvedFiles).toEqual(['/p/.mcp.json'])
    const rj = await host.send({ op: 'mcp/approve', file: '/p/.mcp.json', approved: false })
    expect(rj).toMatchObject({ ok: true })
    expect(approvedFiles).toHaveLength(1)
    host.dispose()
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

  it('批 2：session/archive 已划为人专属（协议通道拒绝）+ rename——sidecar 标记、list 过滤、session/updated 广播', async () => {
    // 2026-09-02 用户拍板：归档不可由 AI/协议通道发起（full-access 会话 curl 静默归档用户
    // 会话的事故根因）。协议 dispatch 一律 HUMAN_ONLY_COMMAND；归档走宿主 archiveSession()
    // 直调（serve /api/archive 人专属端点的同款入口）。
    const dir = mkdtempSync(join(tmpdir(), 'ecode-b2-'))
    const sid = `2026-08-30Tb2h-${Date.now()}`
    const p = new MockProvider([[{ type: 'done', stop_reason: 'end' }]])
    const deps = {
      ...makeDeps(p),
      history: new FileHistoryStore({ sessionId: sid, model: 'm', cwd: '/tmp', dir }),
      cwd: '/tmp',
    }
    deps.history.append({ role: 'user', content: [{ type: 'text', text: 'seed' }] }) // 懒写 meta——jsonl 存在才进 listMetas
    const host = new HostSession(deps)
    const events: ProtocolEvent[] = []
    host.subscribe((e) => events.push(e))

    // 协议通道拒绝（AI/客户端不可达）
    const denied = await host.send({ op: 'session/archive', sessionId: sid, archived: true })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('HUMAN_ONLY_COMMAND')
    // 归档未生效（默认列表仍在）
    const list0 = await host.send({ op: 'session/list' })
    expect((list0.value as Array<{ sessionId: string }>).some((m) => m.sessionId === sid)).toBe(true)

    // 人专属入口（archiveSession 直调）正常执行
    const r1 = await host.archiveSession(sid, true)
    expect(r1.ok).toBe(true)
    // 默认列表过滤归档
    const list = await host.send({ op: 'session/list' })
    expect((list.value as Array<{ sessionId: string }>).some((m) => m.sessionId === sid)).toBe(false)
    // includeArchived 拉到且带标记
    const all = await host.send({ op: 'session/list', includeArchived: true })
    const hit = (all.value as Array<{ sessionId: string; archived?: boolean }>).find((m) => m.sessionId === sid)
    expect(hit?.archived).toBe(true)
    // session/updated 广播帧（多端同步）
    expect(events.some((e) => e.type === 'session/updated' && e.sessionId === sid && e.archived === true)).toBe(true)

    // 重命名：sidecar title + 广播
    await host.send({ op: 'session/rename', sessionId: sid, title: '手起的名字' })
    const all2 = await host.send({ op: 'session/list', includeArchived: true })
    expect((all2.value as Array<{ sessionId: string; title?: string }>).find((m) => m.sessionId === sid)?.title).toBe('手起的名字')
    expect(events.some((e) => e.type === 'session/updated' && e.sessionId === sid && (e as { title?: string }).title === '手起的名字')).toBe(true)

    // 恢复（人专属入口 archived:false）→ 默认列表重新可见
    const r2 = await host.archiveSession(sid, false)
    expect(r2.ok).toBe(true)
    const list2 = await host.send({ op: 'session/list' })
    expect((list2.value as Array<{ sessionId: string }>).some((m) => m.sessionId === sid)).toBe(true)
    host.dispose()
  })

  it('截断全文暂存环形缓冲：messages 与盘上都还没有时 item/read 仍命中（并行轮落盘竞态根治）', async () => {
    // 2026-08-29 dogfood 实测竞态：TUI 收到截断帧即回发 item/read，而 tool_result 要等同轮全部
    // 工具结束才追加进 messages——窗口内内存 mirror 与盘上 backup 双双踩空 → 「全文拉取失败」。
    // 宿主 onToolResult 时已把全文存入暂存环形缓冲；此处用 restoreFrom([]) 清内存 + 默认 Noop
    // 盘源（restoreFull 恒空），item/read 只能靠暂存命中——确定性验证第二源。
    const p = new MockProvider([
      [
        { type: 'tool_use_start', id: 'tRing', name: 'bigout' },
        { type: 'tool_use_end', id: 'tRing' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'text', text: '完成' }, { type: 'done', stop_reason: 'end' }],
    ])
    const host = new HostSession(makeBigDeps(p)) // 默认 Noop store——盘源恒空
    await host.send({ op: 'prompt', text: '跑', mode: 'StartOrSteer' })
    await host.whenIdle()
    host.restoreFrom([]) // 内存 mirror 清空 = 模拟「结果尚未追加进会话记录」的窗口形态
    const r = await host.send({ op: 'item/read', itemId: 'tRing' })
    expect(r.ok).toBe(true)
    expect((r.value as { content: string }).content.length).toBe(10_001)
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

// —— 重连档位失同步修复：sandbox/get 回宿主权威档（附着启动/daemon 重拉重连时点客户端拉取对齐显示）——
describe('sandbox/get 宿主档位回传', () => {
  const makeSandboxDeps = (defaultMode: string | undefined): HostDeps => {
    const deps = makeCmdDeps(new MockProvider([]))
    return { ...deps, getConfig: () => ({ ...deps.getConfig(), sandbox: { defaultMode } }) }
  }

  it('构造时回 config 默认档（defaultMode 配置即启动档）', async () => {
    const host = new HostSession(makeSandboxDeps('read-only'))
    const r = await host.send({ op: 'sandbox/get' })
    expect(r).toMatchObject({ ok: true, value: { mode: 'read-only' } })
    host.dispose()
  })

  it('sandbox/set 切档后回新档（重连客户端拉权威源对齐显示）', async () => {
    const host = new HostSession(makeSandboxDeps(undefined))
    await host.send({ op: 'sandbox/set', mode: 'workspace-write' })
    const r = await host.send({ op: 'sandbox/get' })
    expect(r).toMatchObject({ ok: true, value: { mode: 'workspace-write' } })
    host.dispose()
  })

  it('根因回归钉子：宿主重建（daemon 重拉）档位回 config 默认——旧档只存旧实例内存，客户端必须重拉', async () => {
    // host1：用户切到 read-only（旧 daemon 侧档位）
    const host1 = new HostSession(makeSandboxDeps('default'))
    await host1.send({ op: 'sandbox/set', mode: 'read-only' })
    expect(await host1.send({ op: 'sandbox/get' })).toMatchObject({ value: { mode: 'read-only' } })
    host1.dispose()
    // daemon 崩 → 重拉 = 同 config 新建 HostSession（rescueDaemon reattach 后的宿主真态）：档位已回 default
    const host2 = new HostSession(makeSandboxDeps('default'))
    expect(await host2.send({ op: 'sandbox/get' })).toMatchObject({ value: { mode: 'default' } })
    host2.dispose()
  })
})

// —— 会话级档位隔离（用户拍板 2026-09-02：同项目除非相同对话，否则不互相影响）——
describe('sandbox/mode 会话级档位广播与隔离', () => {
  it('sandbox/set 成功后订阅者收到 sandbox/mode 帧（同对话多端即时对齐）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    await host.send({ op: 'sandbox/set', mode: 'read-only' })
    const frame = events.find((e) => e.type === 'sandbox/mode')
    expect(frame).toMatchObject({ mode: 'read-only' })
    host.dispose()
  })

  it('同项目两个对话互不串台：A 会话订阅者收不到 B 会话的档位帧（channel 会话私有）', async () => {
    const hostA = new HostSession(makeCmdDeps(new MockProvider([])))
    const hostB = new HostSession(makeCmdDeps(new MockProvider([])))
    const eventsA = collect(hostA)
    await hostB.send({ op: 'sandbox/set', mode: 'workspace-write' })
    expect(eventsA.some((e) => e.type === 'sandbox/mode')).toBe(false)
    expect((await hostB.send({ op: 'sandbox/get' })).value).toMatchObject({ mode: 'workspace-write' })
    expect((await hostA.send({ op: 'sandbox/get' })).value).toMatchObject({ mode: 'default' })
    hostA.dispose()
    hostB.dispose()
  })

  it('restoreFrom 换会话档位归零：切对话不带旧档 + 广播归零帧（同实例端口的串台缝）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    const events = collect(host)
    await host.send({ op: 'sandbox/set', mode: 'read-only' })
    events.length = 0
    host.restoreFrom([]) // 换会话载入（Embedded 同实例端口路径）
    expect((await host.send({ op: 'sandbox/get' })).value).toMatchObject({ mode: 'default' })
    const frame = events.find((e) => e.type === 'sandbox/mode')
    expect(frame).toMatchObject({ mode: 'default' })
    host.dispose()
  })

  it('restoreFrom 归零后重新 set 仍可正常切档（归零不是死档）', async () => {
    const host = new HostSession(makeCmdDeps(new MockProvider([])))
    await host.send({ op: 'sandbox/set', mode: 'read-only' })
    host.restoreFrom([])
    await host.send({ op: 'sandbox/set', mode: 'accept-edits' })
    expect((await host.send({ op: 'sandbox/get' })).value).toMatchObject({ mode: 'accept-edits' })
    host.dispose()
  })
})
