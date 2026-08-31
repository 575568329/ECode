/**
 * M12-B2 审批 Broker 测试：分策略表（D6）/fail-closed/always·reject 级联/重放/销毁收敛；
 * spike 场景 3/4/5（可答帧双端收敛、拒绝路径、断线重放）在此转正。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, APPROVAL_TIMEOUT_FEEDBACK } from '../../src/host/approval.js'
import { InMemoryChannel } from '../../src/protocol/channel.js'
import type { ProtocolEvent } from '../../src/protocol/types.js'

const use = (name: string) => ({ type: 'tool_use' as const, id: `u-${name}`, name, input: {} })

function setup(policy: 'ask' | 'auto-approve' = 'ask', withSubscriber = true) {
  const ch = new InMemoryChannel()
  const broker = new ApprovalBroker(ch, policy)
  const events: ProtocolEvent[] = []
  if (withSubscriber) ch.subscribe((e) => events.push(e))
  return { broker, events, ch }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('ApprovalBroker（B2 分策略表）', () => {
  it('tool-confirm：requested 帧带 kind/消毒 preview/decisions（内置工具仅 once+reject）；respond once → resolved + 放行', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('write_file'), `将写入 \x1b[31m文件\x1b[0m 内容`)
    const req = events.find((e) => e.type === 'approval/requested')
    expect(req).toMatchObject({ kind: 'tool-confirm', tool: 'write_file' })
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    expect(req.preview).not.toContain('\x1b') // 消毒：ESC 序列被剥
    expect(req.decisions).toEqual(['once', 'reject'])
    expect(UUID_RE.test(req.requestId)).toBe(true) // requestId 不可预测（P1-2）
    const r = broker.respondApproval(req.requestId, 'once')
    expect(r.accepted).toBe(true)
    expect(await p).toBe(true)
    expect(events.some((e) => e.type === 'approval/resolved' && e.requestId === req.requestId && e.outcome === 'once')).toBe(true)
  })

  it('fail-closed：零订阅者 confirm 直接拒绝', async () => {
    const { broker } = setup('ask', false)
    expect(await broker.confirm(use('write_file'), 'x')).toBe(false)
    expect(broker.pendingCount).toBe(0) // 不留悬挂
  })

  it('审阅批：reject 带 message → confirm 返回反馈串喂回模型（对标 A1）；无 message=false', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('bash'), 'rm -rf tmp')
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    broker.respondApproval(req.requestId, 'reject', '别删 tmp，改用 /tmp 下新目录')
    expect(await p).toBe('别删 tmp，改用 /tmp 下新目录')
  })

  it('D6 分策略表：auto-approve（--yes）只豁免 tool-confirm；sensitive/mcp-permission 永不豁免', async () => {
    const s = setup('auto-approve', false)
    expect(await s.broker.confirm(use('write_file'), 'x')).toBe(true) // --yes 放行副作用工具
    const sens = setup('auto-approve', false)
    expect(await sens.broker.sensitive('read_file', '读取 .env')).toBe(false) // 敏感门不豁免
    const perm = setup('auto-approve', false)
    expect(await perm.broker.permission('ext-a', 'PreToolUse')).toEqual({ allow: false, remember: false })
  })

  it('always 级联（仅 MCP 前缀粒度）：放行同 server 其余 pending', async () => {
    const { broker } = setup()
    const p1 = broker.confirm(use('mcp__srv__a'), 'a')
    const p2 = broker.confirm(use('mcp__srv__b'), 'b')
    const inner = broker.confirm(use('write_file'), '本地工具不受级联')
    const r1 = broker.respondApproval((broker as unknown as { pending: Map<string, { frame: ProtocolEvent }> }).pending.keys().next().value as string, 'always')
    expect(r1.accepted).toBe(true)
    expect(await p1).toBe(true)
    expect(await p2).toBe(true) // 同前缀级联放行
    // 本地工具 pending 不被 always 波及，reject 后拒绝
    const localId = [...(broker as unknown as { pending: Map<string, { frame: ProtocolEvent }> }).pending.keys()][0]
    broker.respondApproval(localId, 'reject')
    expect(await inner).toBe(false)
  })

  it('reject 级联：本会话全部 pending tool-confirm 一并拒绝', async () => {
    const { broker } = setup()
    const p1 = broker.confirm(use('write_file'), 'a')
    const p2 = broker.confirm(use('mcp__x__y'), 'b')
    const id1 = [...(broker as unknown as { pending: Map<string, string> }).pending.keys()][0] as string
    broker.respondApproval(id1, 'reject')
    expect(await p1).toBe(false)
    expect(await p2).toBe(false)
  })

  it('断线重放：pending 期间重投原样帧（requestId/preview 不变）——spike 场景 5', () => {
    const { broker } = setup()
    void broker.confirm(use('write_file'), '预览内容')
    const replayed: ProtocolEvent[] = []
    broker.replayPending((e) => replayed.push(e))
    expect(replayed.length).toBe(1)
    expect(replayed[0]).toMatchObject({ type: 'approval/requested', tool: 'write_file', preview: '预览内容' })
    // HostSession.subscribe 的同款语义（订阅即重放）在 session 集成测试覆盖
  })

  it('dispose：pending 全部 fail-closed 收敛 + cancelled 广播（不留悬挂 Promise）', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('write_file'), 'x')
    broker.dispose()
    expect(await p).toBe(false)
    expect(events.some((e) => e.type === 'approval/resolved' && e.outcome === 'cancelled')).toBe(true)
    expect(broker.pendingCount).toBe(0)
  })

  it('not-pending 回执：重复/伪造 respond 被拒', () => {
    const { broker } = setup()
    expect(broker.respondApproval('00000000-0000-0000-0000-000000000000', 'once')).toMatchObject({ accepted: false, reason: 'not-pending' })
  })
})

describe('ApprovalBroker（M14-C2⑤⑥ claim/审计）', () => {
  it('claim：登记租约 + claimed 广播；advisory——非认领方仍可 respond（防劫持）', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('write_file'), 'x')
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    const r = broker.claim(req.requestId, 'web')
    expect(r.accepted).toBe(true)
    expect(events.some((e) => e.type === 'approval/claimed' && e.requestId === req.requestId && e.claimant === 'web')).toBe(true)
    // 另一端（非认领方）respond 仍被接受——先答先得权威不变
    expect(broker.respondApproval(req.requestId, 'once').accepted).toBe(true)
    expect(await p).toBe(true)
  })

  it('claim not-pending 回执拒绝', () => {
    const { broker } = setup()
    expect(broker.claim('00000000-0000-0000-0000-000000000000', 'web')).toMatchObject({ accepted: false, reason: 'not-pending' })
  })

  it('claim TTL 过期：replayPending 不再重放 claim（认领端崩溃自愈）', async () => {
    vi.useFakeTimers()
    try {
      const ch = new InMemoryChannel()
      const broker = new ApprovalBroker(ch, 'ask')
      const events: ProtocolEvent[] = []
      ch.subscribe((e) => events.push(e))
      const p = broker.confirm(use('write_file'), 'x')
      const req = events.find((e) => e.type === 'approval/requested')
      if (req?.type !== 'approval/requested') throw new Error('unreachable')
      broker.claim(req.requestId, 'web')
      vi.advanceTimersByTime(121_000) // CLAIM_TTL_MS=120s 过期
      const replayed: ProtocolEvent[] = []
      broker.replayPending((e) => replayed.push(e))
      expect(replayed.some((e) => e.type === 'approval/claimed')).toBe(false)
      expect(replayed.some((e) => e.type === 'approval/requested')).toBe(true)
      // 权威不受影响：仍可应答
      expect(broker.respondApproval(req.requestId, 'reject').accepted).toBe(true)
      expect(await p).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('replayPending：有效 claim 随帧重放（断线重连端可见"已在某端处理"）', async () => {
    const { broker, events } = setup()
    const p = broker.confirm(use('write_file'), 'x')
    const req = events.find((e) => e.type === 'approval/requested')
    if (req?.type !== 'approval/requested') throw new Error('unreachable')
    broker.claim(req.requestId, 'feishu')
    const replayed: ProtocolEvent[] = []
    broker.replayPending((e) => replayed.push(e))
    expect(replayed.some((e) => e.type === 'approval/claimed' && e.claimant === 'feishu')).toBe(true)
    broker.respondApproval(req.requestId, 'once')
    await p
  })

  it('审计钩子：asked（登记后）/decided（respond 收敛）成对落钩子', async () => {
    const ch = new InMemoryChannel()
    ch.subscribe(() => {})
    const audit: Array<{ event: string; info: Record<string, unknown> }> = []
    const broker = new ApprovalBroker(ch, 'ask', 0, (event, info) => audit.push({ event, info }))
    const p = broker.confirm(use('write_file'), 'x')
    // asked 审计在登记后同步触发——requestId 从钩子取（避免事件订阅竞态）
    const asked = audit.find((a) => a.event === 'asked')
    if (asked === undefined) throw new Error('asked 审计未触发')
    broker.respondApproval(String(asked.info.requestId), 'reject', '不要动这个文件')
    await p
    expect(audit.map((a) => a.event)).toEqual(['asked', 'decided'])
    expect(asked.info).toMatchObject({ kind: 'tool-confirm', tool: 'write_file' })
    expect(audit[1]?.info).toMatchObject({ outcome: 'reject', message: '不要动这个文件' })
  })

  it('D-T8：超时收敛 → confirm resolve 专用如实反馈串（非 false——用户没拒绝，是无人应答）', async () => {
    const ch = new InMemoryChannel()
    ch.subscribe(() => {})
    const broker = new ApprovalBroker(ch, 'ask', 30)
    const p = broker.confirm(use('bash'), 'rm -rf tmp')
    await new Promise((r) => setTimeout(r, 150))
    expect(await p).toBe(APPROVAL_TIMEOUT_FEEDBACK)
    expect(broker.pendingCount).toBe(0)
  })
})
