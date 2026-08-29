/**
 * F-07 档A：edit/write 会话级 remember 第三键（审批疲劳根治第一步）。
 * - 卡面：edit_file（非敏感）decisions 含 always；write_file 同；bash/敏感路径卡无 always
 * - 放行：respond always 后本会话后续 edit_file/write_file 零审批（同集合互通）
 * - 不残留：session/clear / restoreFrom 清空集合；新 broker 实例（新会话）不互通
 * - 集成（宿主全链路）：a 键放行后同会话第二笔 edit 不再弹 approval/requested
 */

import { describe, it, expect } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import { ApprovalBroker, REMEMBER_TOOLS } from '../../src/host/approval.js'
import { InMemoryChannel } from '../../src/protocol/channel.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'

class ScriptProvider implements LLMProvider {
  readonly type = 'mock'
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const mkTool = (name: string): Tool => ({
  name,
  description: name,
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, content: { type: 'string' }, command: { type: 'string' } },
    required: name === 'bash' ? ['command'] : ['path'],
  },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
})

function makeHost(script: Delta[][], tools: Tool[], defaultMode: 'default' | 'accept-edits' = 'default'): HostSession {
  const reg = new ToolRegistryImpl()
  for (const t of tools) reg.register(t)
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 40,
    sandbox: { ...emptyShellConfig().sandbox, defaultMode },
  }
  return new HostSession({
    providerRegistry: { getByType: () => new ScriptProvider(script) } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
  })
}

const collect = (host: HostSession): ProtocolEvent[] => {
  const evs: ProtocolEvent[] = []
  host.subscribe((ev) => evs.push(ev))
  return evs
}

const editRound = (id: string, path: string): Delta[] => [
  { type: 'tool_use_start', id, name: 'edit_file' },
  { type: 'tool_use_delta', id, partial_json: JSON.stringify({ path, oldString: 'a', newString: 'b' }) },
  { type: 'tool_use_end', id },
  { type: 'done', stop_reason: 'tool_use' },
]

describe('F-07 档A：ApprovalBroker 会话级 remember 集合', () => {
  const use = (name: string) => ({ type: 'tool_use' as const, id: `u-${name}`, name, input: {} })

  function setup() {
    const ch = new InMemoryChannel()
    const broker = new ApprovalBroker(ch, 'ask')
    const events: ProtocolEvent[] = []
    ch.subscribe((e) => events.push(e))
    return { broker, events }
  }

  it('canAlways=true 的 edit/write 卡 decisions 含 always；默认卡不含', async () => {
    const { broker, events } = setup()
    void broker.confirm(use('edit_file'), 'x', true)
    void broker.confirm(use('write_file'), 'y', true)
    void broker.confirm(use('bash'), 'z', true)
    const ds = events.filter((e) => e.type === 'approval/requested').map((e) => (e as { decisions: string[] }).decisions)
    expect(ds[0]).toEqual(['once', 'always', 'reject'])
    expect(ds[1]).toEqual(['once', 'always', 'reject'])
    expect(ds[2]).toEqual(['once', 'reject']) // bash 档A 无第三键
    broker.dispose()
  })

  it('canAlways=true 但工具不在白名单 → 仍无 always（防御）', async () => {
    const { broker, events } = setup()
    void broker.confirm(use('bash'), 'x', true)
    expect((events[0] as { decisions: string[] }).decisions).toEqual(['once', 'reject'])
    broker.dispose()
  })

  it('always 应答 → 入集合；bash 卡不受影响（直放判定在宿主——broker 层不越权）', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('edit_file'), 'x', true)
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    broker.respondApproval(req.requestId, 'always')
    expect(await p).toBe(true)
    expect(broker.rememberedTools.has('edit_file')).toBe(true)
    // broker 不做 remember 直放（不知 path 敏感性）：后续 confirm 仍挂卡（宿主 hostConfirm 负责直放）
    const p2 = broker.confirm(use('write_file'), 'y')
    expect(events.some((e) => e.type === 'approval/requested' && (e as { tool: string }).tool === 'write_file')).toBe(true)
    const pendingInner = broker as unknown as { pending: Map<string, { frame: ProtocolEvent }> }
    const id2 = [...pendingInner.pending.keys()][0]
    broker.respondApproval(id2 as string, 'once')
    expect(await p2).toBe(true)
    // bash 卡无 always 键（档A 范围外）
    const p3 = broker.confirm(use('bash'), 'b')
    const bashReq = events.filter((e) => e.type === 'approval/requested' && (e as { tool: string }).tool === 'bash')[0]
    expect((bashReq as { decisions: string[] }).decisions).toEqual(['once', 'reject'])
    const id3 = [...pendingInner.pending.keys()][0]
    broker.respondApproval(id3 as string, 'reject')
    expect(await p3).toBe(false)
    broker.dispose()
  })

  it('once 应答不入集合；clearRememberedTools 清空', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('edit_file'), 'x', true)
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    broker.respondApproval(req.requestId, 'once')
    await p
    expect(broker.rememberedTools.size).toBe(0)
    const p2 = broker.confirm(use('write_file'), 'y', true)
    const req2 = events.filter((e) => e.type === 'approval/requested')[1]
    broker.respondApproval(req2.requestId, 'always')
    await p2
    expect(broker.rememberedTools.size).toBe(1)
    broker.clearRememberedTools()
    expect(broker.rememberedTools.size).toBe(0)
    broker.dispose()
  })

  it('always 级联：pending 的同集合工具一并放行', async () => {
    const { broker, events } = setup()
    const p1 = broker.confirm(use('edit_file'), 'a', true)
    const p2 = broker.confirm(use('write_file'), 'b', true)
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    broker.respondApproval(req.requestId, 'always')
    expect(await p1).toBe(true)
    expect(await p2).toBe(true) // edit↔write 同集合级联
    broker.dispose()
  })

  it('新 broker 实例（新会话）不残留', async () => {
    const a = setup()
    const p = a.broker.confirm(use('edit_file'), 'x', true)
    const req = a.events.find((e) => e.type === 'approval/requested')
    a.broker.respondApproval(req!.requestId as string, 'always')
    await p
    a.broker.dispose()
    const b = setup()
    expect(b.broker.rememberedTools.size).toBe(0)
    b.broker.dispose()
  })

  it('REMEMBER_TOOLS 白名单恰为 edit_file/write_file', () => {
    expect([...REMEMBER_TOOLS].sort()).toEqual(['edit_file', 'write_file'])
  })
})

describe('F-07 档A：宿主 hostConfirm 集成（default 档）', () => {
  const waitFor = async (evs: ProtocolEvent[], pred: (e: ProtocolEvent) => boolean, host: HostSession): Promise<void> => {
    for (let i = 0; i < 60 && !evs.some(pred); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    void host
  }

  it('a 键（always）放行后：本会话后续 edit_file 零审批 + write_file 同放；bash 仍弹卡', async () => {
    const script: Delta[][] = [
      editRound('e1', 'src/a.ts'),
      [{ type: 'done', stop_reason: 'end' }],
      editRound('e2', 'src/b.ts'),
      [
        { type: 'tool_use_start', id: 'w1', name: 'write_file' },
        { type: 'tool_use_delta', id: 'w1', partial_json: '{"path":"src/c.ts","content":"x"}' },
        { type: 'tool_use_end', id: 'w1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'done', stop_reason: 'end' }],
    ]
    const host = makeHost(script, [mkTool('edit_file'), mkTool('write_file')])
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await waitFor(evs, (e) => e.type === 'approval/requested', host)
    const req = evs.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('第一笔 edit 未弹审批')
    expect(req.tool).toBe('edit_file')
    expect(req.decisions).toEqual(['once', 'always', 'reject']) // 第三键在
    host.send({ op: 'approval/respond', requestId: req.requestId, decision: 'always' })
    await host.whenIdle()
    await host.send({ op: 'prompt', text: 'more', mode: 'StartOrSteer' }) // 第二轮：edit+write
    await host.whenIdle()
    const approvals = evs.filter((e) => e.type === 'approval/requested')
    expect(approvals.length).toBe(1) // 只有第一笔；后续 edit/write 零审批
    expect(evs.some((e) => e.type === 'turn/completed')).toBe(true)
    host.dispose()
  })

  it('敏感路径卡无第三键（.env / .ecode/settings*.json）', async () => {
    for (const p of ['.env', '.ecode/settings.local.json', '.ecode/settings.json']) {
      const script: Delta[][] = [
        [
          { type: 'tool_use_start', id: 's1', name: 'write_file' },
          { type: 'tool_use_delta', id: 's1', partial_json: JSON.stringify({ path: p, content: 'x' }) },
          { type: 'tool_use_end', id: 's1' },
          { type: 'done', stop_reason: 'tool_use' },
        ],
      ]
      const host = makeHost(script, [mkTool('write_file')])
      const evs = collect(host)
      await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
      await waitFor(evs, (e) => e.type === 'approval/requested', host)
      const req = evs.find((e) => e.type === 'approval/requested')
      if (req?.type !== 'approval/requested') throw new Error(`${p} 未弹审批`)
      expect(req.decisions).toEqual(['once', 'reject']) // 敏感卡永不给第三键
      host.dispose()
    }
  })

  it('bash 卡无第三键', async () => {
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 'b1', name: 'bash' },
        { type: 'tool_use_delta', id: 'b1', partial_json: '{"command":"ls"}' },
        { type: 'tool_use_end', id: 'b1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ]
    const host = makeHost(script, [mkTool('bash')])
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await waitFor(evs, (e) => e.type === 'approval/requested', host)
    const req = evs.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('bash 未弹审批')
    expect(req.decisions).toEqual(['once', 'reject'])
    host.dispose()
  })

  it('remember 后敏感路径仍照卡（硬门不随白名单降级）', async () => {
    const script: Delta[][] = [
      editRound('e1', 'src/a.ts'),
      [
        { type: 'tool_use_start', id: 'w1', name: 'write_file' },
        { type: 'tool_use_delta', id: 'w1', partial_json: '{"path":".env","content":"x"}' },
        { type: 'tool_use_end', id: 'w1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ]
    const host = makeHost(script, [mkTool('edit_file'), mkTool('write_file')])
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await waitFor(evs, (e) => e.type === 'approval/requested', host)
    const req = evs.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    host.send({ op: 'approval/respond', requestId: req.requestId, decision: 'always' })
    // 轮会停在 .env 审批挂起——等待第二张卡
    await waitFor(
      evs,
      (e) => e.type === 'approval/requested' && (e as { tool: string }).tool === 'write_file',
      host,
    )
    const req2 = evs.filter((e) => e.type === 'approval/requested')[1]
    expect(req2).toBeDefined()
    if (req2?.type === 'approval/requested') {
      expect(req2.decisions).toEqual(['once', 'reject']) // 白名单内工具但敏感路径：无第三键、照卡
    }
    host.dispose()
  })

  it('session/clear 清空集合（后续 edit 重新弹卡）', async () => {
    const script: Delta[][] = [editRound('e1', 'src/a.ts'), [{ type: 'done', stop_reason: 'end' }]]
    const host = makeHost(script, [mkTool('edit_file')])
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await waitFor(evs, (e) => e.type === 'approval/requested', host)
    const req = evs.find((e) => e.type === 'approval/requested')
    host.send({ op: 'approval/respond', requestId: req!.requestId as string, decision: 'always' })
    await host.whenIdle()
    expect(host.rememberedTools.size).toBe(1)
    await host.send({ op: 'session/clear' })
    expect(host.rememberedTools.size).toBe(0)
    host.dispose()
  })

  it('restoreFrom（换会话）清空集合', async () => {
    const script: Delta[][] = [editRound('e1', 'src/a.ts'), [{ type: 'done', stop_reason: 'end' }]]
    const host = makeHost(script, [mkTool('edit_file')])
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await waitFor(evs, (e) => e.type === 'approval/requested', host)
    const req = evs.find((e) => e.type === 'approval/requested')
    host.send({ op: 'approval/respond', requestId: req!.requestId as string, decision: 'always' })
    await host.whenIdle()
    host.restoreFrom([])
    expect(host.rememberedTools.size).toBe(0)
    host.dispose()
  })
})
