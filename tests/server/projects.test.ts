/**
 * M12-B8：ProjectRegistry 测试——acquire 三段式/冷启动去重/互斥/回收/路径校验/need-confirm。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectRegistry } from '../../src/server/projects.js'
import type { ProjectHost } from '../../src/host/project.js'

const dirs: string[] = []
const mkd = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ecode-proj-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fakeProject = (): ProjectHost =>
  ({ disposeAll: vi.fn(), sweepSessions: vi.fn(() => 0) } as unknown as ProjectHost)

const makeRegistry = (created: ProjectHost[]) =>
  new ProjectRegistry({
    createSession: (cwd) => {
      void cwd
      const h = fakeProject()
      created.push(h)
      return h
    },
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
    const created: ProjectHost[] = []
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

  it('审阅批：createSession 抛错 → assemble-failed 带原因（不再卡死单飞），且可重试成功', async () => {
    let shouldThrow = true
    const created: ProjectHost[] = []
    const reg = new ProjectRegistry({
      createSession: () => {
        if (shouldThrow) throw new Error('MCP 装配炸了')
        const h = fakeProject()
        created.push(h)
        return h
      },
      lockDir: join(tmpdir(), `ecode-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    })
    const dir = mkd()
    reg.register(dir)
    const r1 = await reg.acquire(dir)
    expect(r1).toMatchObject({ ok: false, reason: 'assemble-failed', errorMessage: 'MCP 装配炸了' })
    // 锁已回滚：环境恢复后同一目录重试成功（旧实现 pendingAcquire 死条目+锁残留=永久卡死）
    shouldThrow = false
    const r2 = await reg.acquire(dir)
    expect(r2.ok).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('项目互斥：同路径二次 acquire（新 registry 实例=另一进程视角）被 lock 拒绝', async () => {
    const created: ProjectHost[] = []
    const opts = {
      createSession: () => {
        const h = fakeProject()
        created.push(h)
        return h
      },
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

  it('M13-W2 会话级回收委托：sweepSessions 透传阈值给各 ProjectHost；项目基座常驻（listActive 不减）', async () => {
    const created: ProjectHost[] = []
    const reg = makeRegistry(created)
    const dir = mkd()
    reg.register(dir)
    const r = await reg.acquire(dir)
    expect(r.ok).toBe(true)
    ;(r.host as unknown as { sweepSessions: ReturnType<typeof vi.fn> }).sweepSessions.mockReturnValue(3)
    expect(reg.sweepSessions(120)).toBe(3)
    expect((r.host as unknown as { sweepSessions: ReturnType<typeof vi.fn> }).sweepSessions).toHaveBeenCalledWith(120)
    expect(reg.listActive()).toHaveLength(1) // 项目仍在（Q5 常驻）——回收发生在会话层
  })
})
