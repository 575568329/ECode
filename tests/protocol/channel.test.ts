/**
 * M12 B0 协议地基测试：InMemoryChannel 的通道纪律（spike 断言转正的 channel 层部分）。
 * Broker 相关（可答帧/重放/级联）在 B2 的 approval 测试补齐。
 */
import { describe, expect, it, vi } from 'vitest'
import { InMemoryChannel } from '../../src/protocol/channel.js'
import type { PublishableEvent } from '../../src/protocol/types.js'

const ev = (type: PublishableEvent['type'], extra: Record<string, unknown> = {}): PublishableEvent =>
  ({ type, ...extra } as PublishableEvent)

describe('InMemoryChannel（阶段 1 同进程通道）', () => {
  it('publish 分配会话级单调 seq，订阅者按序收到', () => {
    const ch = new InMemoryChannel()
    const got: number[] = []
    ch.subscribe((e) => got.push(e.seq))
    ch.publish(ev('delta', { turnId: 't1', text: 'a' }))
    ch.publish(ev('delta', { turnId: 't1', text: 'b' }))
    ch.publish(ev('turn/completed', { turnId: 't1' }))
    expect(got).toEqual([1, 2, 3])
    expect(ch.lastSeq).toBe(3)
  })

  it('多订阅者 fan-out：每个订阅者独立收到同一帧', () => {
    const ch = new InMemoryChannel()
    const a: string[] = []
    const b: string[] = []
    const unA = ch.subscribe((e) => a.push(e.type))
    ch.subscribe((e) => b.push(e.type))
    ch.publish(ev('warn', { text: 'x' }))
    unA()
    ch.publish(ev('warn', { text: 'y' }))
    expect(a).toEqual(['warn'])
    expect(b).toEqual(['warn', 'warn']) // 退订只影响自己
  })

  it('send 分发到宿主分发器并回传结果', async () => {
    const ch = new InMemoryChannel()
    ch.bind(async (cmd) =>
      cmd.op === 'prompt' ? { ok: true, routed: 'Started' } : { ok: false, error: '不支持' },
    )
    const r = await ch.send({ op: 'prompt', text: '你好', mode: 'StartOrSteer' })
    expect(r).toMatchObject({ ok: true, routed: 'Started' })
  })

  it('分发器异常收敛为 ok:false 回执（不向客户端 throw）', async () => {
    const ch = new InMemoryChannel()
    ch.bind(async () => {
      throw new Error('宿主炸了')
    })
    const r = await ch.send({ op: 'interrupt' })
    expect(r).toMatchObject({ ok: false, code: 'DISPATCH_ERROR' })
  })

  it('未绑定分发器 / 已销毁：回执式失败', async () => {
    const ch = new InMemoryChannel()
    expect(await ch.send({ op: 'session/list' })).toMatchObject({ ok: false, code: 'NO_DISPATCHER' })
    ch.dispose()
    expect(await ch.send({ op: 'session/list' })).toMatchObject({ ok: false, code: 'DISPOSED' })
    // dispose 后 publish 不炸、也不投递
    const h = vi.fn()
    ch.subscribe(h)
    ch.publish(ev('warn', { text: 'z' }))
    expect(h).not.toHaveBeenCalled()
  })

  it('协议纪律：事件是纯数据（JSON roundtrip 深相等——锁「不共享对象引用」）', () => {
    const ch = new InMemoryChannel()
    let received: unknown = null
    ch.subscribe((e) => (received = e))
    const nested = { items: ['a', 'b'], view: { name: 'n' } }
    ch.publish(ev('queue/snapshot', nested))
    expect(JSON.parse(JSON.stringify(received))).toEqual(received)
    // 发布后变更源对象不影响已发帧（快照语义）
    nested.items.push('c')
    expect((received as { items: string[] }).items).toEqual(['a', 'b'])
  })
})
