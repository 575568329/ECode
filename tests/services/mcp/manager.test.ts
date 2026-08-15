import { describe, it, expect, vi } from 'vitest'
import { McpManager, type McpClientLike } from '../../../src/services/mcp/manager.js'
import { McpCache, type McpToolDef } from '../../../src/services/mcp/cache.js'
import type { McpServerEntry } from '../../../src/services/mcp/config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const TOOLS: McpToolDef[] = [
  { name: 'read', description: '读', inputSchema: { type: 'object' } },
  { name: 'write', description: '写' },
]

function fakeClient(opts: { failList?: boolean } = {}): McpClientLike {
  return {
    listTools: async () => {
      if (opts.failList) throw new Error('listTools 炸了')
      return { tools: TOOLS }
    },
    close: async () => {},
  }
}

function entry(name: string, overrides: Partial<McpServerEntry['cfg']> = {}): McpServerEntry {
  return { name, source: 'user', cfg: { type: 'stdio', command: 'node', args: ['x'], ...overrides } }
}

describe('McpManager（M-P2）', () => {
  it('cache 命中 → cached + 注册工具，启动零连接', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-mcp-'))
    const cache = new McpCache(path.join(dir, 'cache.json'))
    const e = entry('fs')
    await cache.set('fs', { configHash: (await import('../../../src/services/mcp/cache.js')).configHashOf(e.cfg), tools: TOOLS, cachedAt: 0 })
    const onTools = vi.fn()
    const connectFn = vi.fn(async () => fakeClient())
    const mgr = new McpManager({ cache, onTools, connectFn, healthIntervalMs: 0 })
    await mgr.start([e])
    expect(connectFn).not.toHaveBeenCalled() // 零连接
    expect(mgr.status()[0]).toMatchObject({ name: 'fs', status: 'cached', toolCount: 2 })
    expect(onTools).toHaveBeenCalledWith('fs', TOOLS, e.cfg)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lazy + 无缓存 → bootstrap 连一次（后台），连上即注册并回写 cache', async () => {
    const onTools = vi.fn()
    const connectFn = vi.fn(async () => fakeClient())
    const cacheSet = vi.fn()
    const cacheLike = { get: () => undefined, set: cacheSet as unknown as () => Promise<void> }
    const mgr = new McpManager({ cache: cacheLike as unknown as McpCache, onTools, connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('db')])
    await new Promise((r) => setTimeout(r, 20)) // 等 bootstrap promise
    expect(connectFn).toHaveBeenCalledTimes(1)
    expect(onTools).toHaveBeenCalledWith('db', TOOLS, expect.anything())
    expect(cacheSet).toHaveBeenCalled()
    expect(mgr.status()[0]).toMatchObject({ status: 'connected' })
  })

  it('eager：启动即连；失败标 failed 不阻塞', async () => {
    let fail = true
    const connectFn = vi.fn(async () => {
      if (fail) throw new Error('spawn ENOENT')
      return fakeClient()
    })
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    const r = await mgr.start([entry('e', { lifecycle: 'eager' })])
    expect(r.failed).toEqual(['e'])
    expect(mgr.status()[0]).toMatchObject({ status: 'failed', error: 'spawn ENOENT' })
    // failed 过期后 eager 语义 = lazy（下次调用拉起）；reconnect 清退避
    fail = false
    await mgr.reconnect('e')
    expect(mgr.status()[0].status).toBe('connected')
  })

  it('lazyConnect 并发去重：同 server 共享一个 Promise', async () => {
    let resolveConnect: (c: McpClientLike) => void = () => {}
    const connectFn = vi.fn(
      () => new Promise<McpClientLike>((res) => (resolveConnect = res)),
    )
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('x')])
    const p1 = mgr.lazyConnect('x')
    const p2 = mgr.lazyConnect('x')
    resolveConnect(fakeClient())
    await Promise.all([p1, p2])
    expect(connectFn).toHaveBeenCalledTimes(1)
  })

  it('退避：failed 后 60s 内调用直接拒绝并提示 reconnect', async () => {
    let t = 1000
    const connectFn = vi.fn(async () => {
      throw new Error('连不上')
    })
    const mgr = new McpManager({ connectFn, now: () => t, healthIntervalMs: 0 })
    await mgr.start([entry('y')])
    await expect(mgr.lazyConnect('y')).rejects.toThrow('连不上')
    await expect(mgr.lazyConnect('y')).rejects.toThrow('/mcp reconnect y')
    expect(connectFn).toHaveBeenCalledTimes(1) // 退避期内不再真连
    t += 61_000
    await mgr.reconnect('y') // reconnect 清退避
    expect(connectFn).toHaveBeenCalledTimes(2)
  })

  it('abort（用户中断）≠ 故障：状态回退不记退避', async () => {
    const ac = new AbortController()
    const connectFn = vi.fn(
      (_n: string, _c: unknown, signal?: AbortSignal) =>
        new Promise<McpClientLike>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
    )
    // cache 命中 → cached 态（不触发 bootstrap 连接，避免与被 abort 的共享 Promise 纠缠）
    const cacheLike = { get: () => ({ configHash: 'x', tools: TOOLS, cachedAt: 0 }), set: async () => {} }
    const mgr = new McpManager({ connectFn, cache: cacheLike as unknown as McpCache, healthIntervalMs: 0 })
    await mgr.start([entry('z')])
    expect(mgr.status()[0].status).toBe('cached')
    const p = mgr.lazyConnect('z', ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow()
    expect(mgr.status()[0].status).toBe('cached') // 回退 cached，不是 failed
    // 不记退避：立刻可再连（换一个会成功的 connectFn）
    const connectFn2 = vi.fn(async () => fakeClient())
    ;(mgr as unknown as { connectFn: unknown }).connectFn = connectFn2
    await expect(mgr.lazyConnect('z')).resolves.toBeDefined()
  })

  it('connecting 期间断开 → pendingDisconnect 落地即关', async () => {
    let resolveConnect: (c: McpClientLike) => void = () => {}
    const close = vi.fn(async () => {})
    const connectFn = vi.fn(() => new Promise<McpClientLike>((res) => (resolveConnect = res)))
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('w')])
    const p = mgr.lazyConnect('w')
    await mgr.close('w') // connecting 中断开
    resolveConnect({ listTools: async () => ({ tools: TOOLS }), close })
    await p
    expect(close).toHaveBeenCalled() // 落地即关
    expect(mgr.status()[0].status).toBe('cached')
  })

  it('空闲卸载：超时且 inFlight=0 → close 回 cached；eager 默认不断开', async () => {
    let t = 1000
    const close = vi.fn(async () => {})
    const connectFn = vi.fn(async () => ({ listTools: async () => ({ tools: TOOLS }), close }))
    const mgr = new McpManager({ connectFn, now: () => t, healthIntervalMs: 0, defaultIdleMs: 600_000 })
    await mgr.start([entry('lazy-srv'), entry('eager-srv', { lifecycle: 'eager' })])
    await mgr.lazyConnect('lazy-srv')
    t += 601_000 // 10 分钟后
    mgr.tick()
    await new Promise((r) => setTimeout(r, 10))
    expect(close).toHaveBeenCalledTimes(1) // 只 lazy 那台
    expect(mgr.status().find((s) => s.name === 'lazy-srv')?.status).toBe('cached')
    expect(mgr.status().find((s) => s.name === 'eager-srv')?.status).toBe('connected')
  })

  it('failed 过期降级：有缓存→cached，无缓存→not-connected', async () => {
    let t = 1000
    const connectFn = vi.fn(async () => {
      throw new Error('x')
    })
    const cacheLike = { get: () => undefined, set: async () => {} }
    const mgr = new McpManager({ connectFn, now: () => t, cache: cacheLike as unknown as McpCache, healthIntervalMs: 0 })
    const es = entry('noCache')
    await mgr.start([es])
    // noCache bootstrap 失败（后台），等一下
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.status().find((s) => s.name === 'noCache')?.status).toBe('failed')
    t += 61_000
    mgr.tick()
    expect(mgr.status().find((s) => s.name === 'noCache')?.status).toBe('not-connected')
  })

  it('markBroken：死连接置 failed 清句柄，下次调用重连', async () => {
    const clients: McpClientLike[] = [fakeClient(), fakeClient()]
    let i = 0
    const connectFn = vi.fn(async () => clients[i++ % clients.length]!)
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('b')])
    await mgr.lazyConnect('b')
    mgr.markBroken('b', '管道断裂')
    expect(mgr.status()[0]).toMatchObject({ status: 'failed', error: '管道断裂' })
    // 退避期内…… markBroken 记了 failedAt，直接调用会被退避挡——真实场景 execute 返回 is_error，
    // LLM 重试在 60s 后或用户 reconnect。此处验证 reconnect 立即恢复：
    await mgr.reconnect('b')
    expect(mgr.status()[0].status).toBe('connected')
    expect(connectFn).toHaveBeenCalledTimes(2) // 真重连
  })

  it('disabled：不注册不连接；reconnect 跳过', async () => {
    const connectFn = vi.fn(async () => fakeClient())
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('off', { enabled: false })])
    expect(mgr.status()[0].status).toBe('disabled')
    await mgr.reconnect('off')
    expect(connectFn).not.toHaveBeenCalled()
    await expect(mgr.lazyConnect('off')).rejects.toThrow('已禁用')
  })

  it('stop：全部 close + 定时器清', async () => {
    const close = vi.fn(async () => {})
    const connectFn = vi.fn(async () => ({ listTools: async () => ({ tools: TOOLS }), close }))
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('a'), entry('b')])
    await mgr.lazyConnect('a')
    await mgr.stop()
    expect(close).toHaveBeenCalled()
  })

  it('beginCall/endCall 维持在飞计数（空闲卸载不切在飞调用）', async () => {
    let t = 1000
    const close = vi.fn(async () => {})
    const connectFn = vi.fn(async () => ({ listTools: async () => ({ tools: TOOLS }), close }))
    const mgr = new McpManager({ connectFn, now: () => t, healthIntervalMs: 0 })
    await mgr.start([entry('busy')])
    await mgr.lazyConnect('busy')
    mgr.beginCall('busy')
    t += 601_000
    mgr.tick()
    await new Promise((r) => setTimeout(r, 10))
    expect(close).not.toHaveBeenCalled() // 在飞，不卸载
    mgr.endCall('busy')
    mgr.tick()
    await new Promise((r) => setTimeout(r, 10))
    expect(close).toHaveBeenCalled()
  })
})

describe('McpManager 审阅修复回归', () => {
  it('P0：二段 start（追加）不重建已有 state——已连接 client 保留、eager 不二次连接', async () => {
    const close = vi.fn(async () => {})
    const clients = [
      { listTools: async () => ({ tools: TOOLS }), callTool: async () => ({ content: [] }), close },
      { listTools: async () => ({ tools: TOOLS }), callTool: async () => ({ content: [] }), close },
    ]
    let i = 0
    const connectFn = vi.fn(async () => clients[i++ % clients.length]!)
    const cacheLike = { get: () => undefined, set: async () => {} }
    const mgr = new McpManager({ connectFn, cache: cacheLike as unknown as McpCache, healthIntervalMs: 0 })
    // 第一段：eager 启动即连
    const r1 = await mgr.start([entry('u-eager', { lifecycle: 'eager' })])
    expect(r1.connected).toBe(1)
    expect(connectFn).toHaveBeenCalledTimes(1)
    // 第二段：批准后传全量（含已注册的用户级 + 新项目级）——不得覆盖/重连已有
    await mgr.start([entry('u-eager', { lifecycle: 'eager' }), entry('p-new', { lifecycle: 'eager', enabled: true })])
    expect(connectFn).toHaveBeenCalledTimes(2) // 只连了 p-new，u-eager 未重连
    expect(mgr.status().find((s) => s.name === 'u-eager')?.status).toBe('connected') // 未回退
    await mgr.stop()
    expect(close).toHaveBeenCalledTimes(2) // 两个 client 都被管理（不孤儿）
  })

  it('P1：显式 lifecycle:"lazy" + 无缓存 → bootstrap 正常拿清单（不死锁）', async () => {
    const onTools = vi.fn()
    const connectFn = vi.fn(async () => fakeClient())
    const cacheLike = { get: () => undefined, set: async () => {} }
    const mgr = new McpManager({ connectFn, cache: cacheLike as unknown as McpCache, onTools, healthIntervalMs: 0 })
    await mgr.start([entry('explicit', { lifecycle: 'lazy' })])
    await new Promise((r) => setTimeout(r, 20))
    expect(connectFn).toHaveBeenCalledTimes(1)
    expect(onTools).toHaveBeenCalled()
  })

  it('P1：abort 归属共享——B 加入在飞连接后 A 中断可终止握手；B 单独中断也可', async () => {
    const acA = new AbortController()
    const acB = new AbortController()
    const connectFn = vi.fn(
      (_n: string, _c: unknown, signal?: AbortSignal) =>
        new Promise<McpClientLike>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
    )
    const cacheLike = { get: () => ({ configHash: 'x', tools: TOOLS, cachedAt: 0 }), set: async () => {} }
    const mgr = new McpManager({ connectFn, cache: cacheLike as unknown as McpCache, healthIntervalMs: 0 })
    await mgr.start([entry('shared')])
    const pA = mgr.lazyConnect('shared', acA.signal)
    const pB = mgr.lazyConnect('shared', acB.signal) // B 共享在飞连接
    acA.abort() // 任意等待者中断都应终止
    await expect(pA).rejects.toThrow()
    await expect(pB).rejects.toThrow()
  })

  it('P1：refreshMetadata 失败（半连接）→ client 被 close（不泄漏）', async () => {
    const close = vi.fn(async () => {})
    const connectFn = vi.fn(async () => ({
      listTools: async () => {
        throw new Error('listTools 炸了')
      },
      callTool: async () => ({ content: [] }),
      close,
    }))
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('half')]) // cache miss → bootstrap → listTools 失败
    await new Promise((r) => setTimeout(r, 20))
    expect(close).toHaveBeenCalledTimes(1) // 半连接被清理
    expect(mgr.status()[0]).toMatchObject({ status: 'failed' })
  })
})

describe('stopNow（退出同步兜底）', () => {
  it('同步 killNow 全部 client + 清定时器，不等协议', async () => {
    const killNow = vi.fn()
    const connectFn = vi.fn(async () => ({
      listTools: async () => ({ tools: TOOLS }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
      killNow,
    }))
    const mgr = new McpManager({ connectFn, healthIntervalMs: 0 })
    await mgr.start([entry('a'), entry('b', { enabled: false })])
    await mgr.lazyConnect('a')
    mgr.stopNow() // 同步：无 await 也应已杀
    expect(killNow).toHaveBeenCalledTimes(1) // 只杀已连接的（disabled 无 client）
    expect(mgr.status().find((s) => s.name === 'a')?.status).toBe('cached')
  })
})
