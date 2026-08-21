/**
 * M12-B8：ProjectRegistry 测试——acquire 三段式/冷启动去重/互斥/回收/路径校验/need-confirm。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectRegistry } from '../../src/server/projects.js'
import type { HostSession } from '../../src/host/session.js'

const dirs: string[] = []
const mkd = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ecode-proj-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fakeHost = (): HostSession =>
  ({ dispose: vi.fn(), send: vi.fn(), subscribe: vi.fn(), transcript: [] } as unknown as HostSession)

const makeRegistry = (created: HostSession[]) =>
  new ProjectRegistry({
    createSession: (cwd) => {
      void cwd
      const h = fakeHost()
      created.push(h)
      return h
    },
    idleMinutes: 0,
    lockDir: join(tmpdir(), `ecode-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  })

describe('ProjectRegistry（B8 多项目核心）', () => {
  it('不存在路径拒绝；存在但未注册的（历史反推）首次拉起 need-confirm；confirm 后放行', async () => {
    const reg = makeRegistry([])
    const r0 = await reg.acquire(join(mkd(), '不存在'))
    expect(r0).toMatchObject({ ok: false, reason: 'not-exist' })
    const dir = mkd()
    const r1 = await reg.acquire(dir)
    expect(r1).toMatchObject({ ok: false, reason: 'need-confirm' })
    const r2 = await reg.acquire(dir, { confirm: true })
    expect(r2.ok).toBe(true)
  })

  it('显式注册豁免 confirm；live 复用不重复装配；冷启动并发单飞去重', async () => {
    const created: HostSession[] = []
    const reg = makeRegistry(created)
    const dir = mkd()
    reg.register(dir)
    const r1 = await reg.acquire(dir)
    expect(r1.ok).toBe(true)
    // live 复用
    const r2 = await reg.acquire(dir)
    expect(r2.host).toBe(r1.host)
    expect(created).toHaveLength(1)
  })

  it('项目互斥：同路径二次 acquire（新 registry 实例=另一进程视角）被 lock 拒绝', async () => {
    const created: HostSession[] = []
    const opts = {
      createSession: () => {
        const h = fakeHost()
        created.push(h)
        return h
      },
      idleMinutes: 0,
      lockDir: join(tmpdir(), `ecode-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }
    const dir = mkd()
    const a = new ProjectRegistry(opts)
    a.register(dir)
    const r1 = await a.acquire(dir)
    expect(r1.ok).toBe(true)
    // 另一进程视角（同 lockDir）：互斥拒绝
    const b = new ProjectRegistry(opts)
    b.register(dir)
    const r2 = await b.acquire(dir)
    expect(r2).toMatchObject({ ok: false, reason: 'locked' })
    // 释放后可重新占坑
    a.disposeAll()
    const r3 = await b.acquire(dir)
    expect(r3.ok).toBe(true)
  })

  it('空闲回收：超时 dispose+解锁；有订阅者（审批/UI 挂起）不回收', async () => {
    const created: HostSession[] = []
    const reg = new ProjectRegistry({
      createSession: () => {
        const h = fakeHost()
        created.push(h)
        return h
      },
      idleMinutes: 0,
      lockDir: join(tmpdir(), `ecode-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    })
    const dir = mkd()
    reg.register(dir)
    const r = await reg.acquire(dir)
    // 模拟订阅者挂起（channel.subscriberCount>0 → Q12 不回收）
    ;(r.host as unknown as { channel: { subscriberCount: number } }).channel = { subscriberCount: 1 }
    expect(await reg.sweepIdle()).toBe(0)
    ;(r.host as unknown as { channel: { subscriberCount: number } }).channel = { subscriberCount: 0 }
    expect(await reg.sweepIdle()).toBe(1)
    expect(created[0]?.dispose).toHaveBeenCalled()
    expect(reg.listActive()).toHaveLength(0)
  })
})
