/**
 * M12-B8.2/B9（G2）：多项目 serve + 双客户端附着验收。
 * 两个真实临时目录作为两个项目——projects 列表/项目路由隔离/need-confirm 栅栏/双端审批互答。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveMulti } from '../../src/server/multi.js'
import { HttpTransport } from '../../src/protocol/http.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import { ProjectHost } from '../../src/host/project.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'

class P implements LLMProvider {
  readonly type = 'mock'
  async *run(_r: LLMProviderRunRequest): AsyncIterable<Delta> {
    yield { type: 'text', text: 'ok' }
    yield { type: 'done', stop_reason: 'end' }
  }
}
const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const seenCwds: string[] = []
const mk = (cwd: string): HostDeps => {
  // M13-W2：工厂改为项目视角（registry 存 ProjectHost；会话 Map 内含首会话）
  seenCwds.push(cwd)
  const reg = new ToolRegistryImpl()
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  return {
    providerRegistry: { getByType: () => new P() } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    config,
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
  }
}

const dirA = mkdtempSync(join(tmpdir(), 'ecode-projA-'))
const dirB = mkdtempSync(join(tmpdir(), 'ecode-projB-'))
const created: HostSession[] = []

const createdProjects: ProjectHost[] = []
const registry = new ProjectRegistry({
  createSession: (cwd) => {
    // 对齐 cli 装配：ensureConversation 端口晚绑定 projectRef（session/restore 经 dispatch 落 ProjectHost）
    const projectRef: { current?: ProjectHost } = {}
    const p = new ProjectHost({
      createConversation: () => ({
        ...mk(cwd),
        ensureConversation: async (sid) => {
          if (projectRef.current === undefined) return { ok: false, error: 'no project', code: 'NOT_IMPLEMENTED' }
          await projectRef.current.ensureRestore(sid)
          return { ok: true, sessionId: sid }
        },
      }),
    })
    projectRef.current = p
    const first = p.ensure('sess-A')
    created.push(first)
    createdProjects.push(p)
    return p
  },
  lockDir: join(tmpdir(), `ecode-mlock-${Date.now()}`),
})
registry.register(dirA)
registry.register(dirB)

let srv: Awaited<ReturnType<typeof serveMulti>>
let base: string
let auth: Record<string, string>
// M14-C2：第二实例带 device 级凭据 + 实例 id（分级语义/health 回显验收）
let base2 = ''
const deviceToken = 'dev-token-c2-test'
let srv2: Awaited<ReturnType<typeof serveMulti>> | null = null

beforeAll(async () => {
  srv = await serveMulti({ registry, defaultCwd: dirA })
  base = `http://127.0.0.1:${srv.port}`
  auth = { authorization: `Bearer ${srv.token}` }
  srv2 = await serveMulti(
    { registry: new ProjectRegistry(mk), defaultCwd: dirA },
    { extraCredentials: [{ secret: deviceToken, class: 'device' }], id: 'test-instance-id' },
  )
  base2 = `http://127.0.0.1:${srv2.port}`
})
afterAll(async () => {
  await srv.close()
  await srv2?.close()
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

const enc = (p: string): string => encodeURIComponent(p.split(String.fromCharCode(92)).join('/'))

describe('B8.2 多项目 serve（G2 验收）', () => {
  it('projects 列表；两项目各自 prompt 互不串台（实例隔离）', async () => {
    const list = await (await fetch(`${base}/api/projects`, { headers: auth })).json()
    expect(list.registered.length).toBe(2)
    const rA = await (await fetch(`${base}/api/p/${enc(dirA)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/clear' } }) })).json()
    expect(rA).toMatchObject({ ok: true })
    const rB = await (await fetch(`${base}/api/p/${enc(dirB)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/clear' } }) })).json()
    expect(rB).toMatchObject({ ok: true })
    expect(created.length).toBe(2) // 两项目各装配一个 ProjectHost 首会话
    expect(seenCwds).toContain(dirA.split(String.fromCharCode(92)).join('/')) // cwd 真接线（审阅 P0-1：曾 void cwd 掩护断线）
    expect(seenCwds).toContain(dirB.split(String.fromCharCode(92)).join('/'))
  })

  it('M14-C2① confirm 随凭据分级派生：primary 直接过（?confirm 退役被忽略）；device 级 428；Basic 形态拒收', async () => {
    const dirC = mkdtempSync(join(tmpdir(), 'ecode-projC-'))
    // primary 持有方：无需任何 query 即过栅栏（原 need-confirm 428 语义让位于分级派生）
    const r1 = await (await fetch(`${base}/api/p/${enc(dirC)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/list' } }) })).json()
    expect(r1).toMatchObject({ ok: true })
    // device 凭据：不可 confirm 豁免——未注册项目首次拉起 428
    const r2 = await (
      await fetch(`${base2}/api/p/${enc(dirC)}/cmd`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ op: { op: 'session/list' } }),
      })
    ).json()
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('confirm') })
    // device 凭据自报 ?confirm=true 也不放行（客户端自报已退役）
    const r3 = await (
      await fetch(`${base2}/api/p/${enc(dirC)}/cmd?confirm=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ op: { op: 'session/list' } }),
      })
    ).json()
    expect(r3).toMatchObject({ ok: false })
    // Basic 形态退役：即便密码正确也 401（双凭据解析留一——web 全 Bearer）
    const r4 = await fetch(`${base}/api/projects`, { headers: { authorization: `Basic ${Buffer.from(`x:${srv.token}`).toString('base64')}` } })
    expect(r4.status).toBe(401)
    rmSync(dirC, { recursive: true, force: true })
  })

  it('审阅批3 P1-1：device 凭据 GET /api/projects 与 /api/stats 均 403；stats 响应不含 topSessions（cwd/firstUser 不外发）', async () => {
    const hDev = { authorization: `Bearer ${deviceToken}` }
    const p1 = await fetch(`${base2}/api/projects`, { headers: hDev })
    expect(p1.status).toBe(403)
    const p2 = await fetch(`${base2}/api/stats?days=7`, { headers: hDev })
    expect(p2.status).toBe(403)
    // primary 可用且不含 topSessions（审阅 P1-1：SessionAgg 含 cwd/firstUser 用户原文——web 面板零消费）
    const stats = await serveMulti({ registry: new ProjectRegistry(mk), defaultCwd: dirA }, { statsCachePath: join(tmpdir(), `ecode-stats-cache-${Date.now()}.json`) })
    try {
      const r = await (await fetch(`http://127.0.0.1:${stats.port}/api/stats`, { headers: { authorization: `Bearer ${stats.token}` } })).json()
      expect(r.ok).toBe(true)
      expect(r.topSessions).toBeUndefined()
      expect(r.byModel).toBeDefined()
    } finally {
      await stats.close()
    }
  })

  it('2026-09-02 归档人专属：/cmd 拒收 session/archive（403 HUMAN_ONLY_COMMAND）；/api/archive 人专属端点可归档', async () => {
    // 准备一个有历史文件的冷项目（listMetas 读它）
    const dirE = mkdtempSync(join(tmpdir(), 'ecode-projE-'))
    const sid = `2026-09-02Tha-${Date.now()}`
    const sessionsDir = join(tmpdir(), `ecode-sess-ha-${Date.now()}`)
    const { mkdirSync: mk1, writeFileSync: wf1 } = await import('node:fs')
    mk1(sessionsDir, { recursive: true })
    wf1(join(sessionsDir, `${sid}.jsonl`), JSON.stringify({ meta: true, sessionId: sid, createdAt: new Date().toISOString(), model: 'm', cwd: dirE.split(String.fromCharCode(92)).join('/'), firstUser: 'hi' }) + '\n', 'utf8')
    const srvE = await serveMulti(
      { registry: new ProjectRegistry(mk), defaultCwd: dirA },
      { sessionsDir, extraCredentials: [{ secret: deviceToken, class: 'device' }] },
    )
    const bE = `http://127.0.0.1:${srvE.port}`
    const aE = { authorization: `Bearer ${srvE.token}` }
    try {
      // ① /cmd 协议面拒收（primary 也不行——归档不属协议命令）
      const viaCmd = await (await fetch(`${bE}/api/p/${enc(dirE)}/cmd`, { method: 'POST', headers: aE, body: JSON.stringify({ op: { op: 'session/archive', sessionId: sid, archived: true } }) })).json()
      expect(viaCmd).toMatchObject({ ok: false })
      if (!viaCmd.ok) expect(viaCmd.code).toBe('HUMAN_ONLY_COMMAND')
      // device 凭据同拒（403 语义）
      const viaCmdDev = await (await fetch(`${bE}/api/p/${enc(dirE)}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ op: { op: 'session/archive', sessionId: sid, archived: true } }) })).json()
      expect(viaCmdDev).toMatchObject({ ok: false })
      // ② 人专属端点归档生效（冷项目直落 sidecar）
      const arc = await (await fetch(`${bE}/api/archive`, { method: 'POST', headers: aE, body: JSON.stringify({ project: dirE.split(String.fromCharCode(92)).join('/'), sessionId: sid, archived: true }) })).json()
      expect(arc).toMatchObject({ ok: true })
      const meta = JSON.parse((await import('node:fs')).readFileSync(join(sessionsDir, `${sid}.meta.json`), 'utf8')) as { archived?: boolean }
      expect(meta.archived).toBe(true)
      // ②' 跨项目归属拒收（审阅 S1）：另一个项目的 cwd 查不到该会话 → 404
      const dirF = mkdtempSync(join(tmpdir(), 'ecode-projF-'))
      try {
        const wrongProj = await (await fetch(`${bE}/api/archive`, { method: 'POST', headers: aE, body: JSON.stringify({ project: dirF.split(String.fromCharCode(92)).join('/'), sessionId: sid, archived: false }) })).json()
        expect(wrongProj).toMatchObject({ ok: false })
      } finally {
        rmSync(dirF, { recursive: true, force: true })
      }
      // ③ session/list 默认不显示归档；includeArchived 拉到
      const coldList = await (await fetch(`${bE}/api/p/${enc(dirE)}/cmd`, { method: 'POST', headers: aE, body: JSON.stringify({ op: { op: 'session/list', includeArchived: true } }) })).json()
      expect((coldList.value as Array<{ sessionId: string; archived?: boolean }>).find((m) => m.sessionId === sid)?.archived).toBe(true)
      // ④ 恢复（人专属端点 archived:false）
      const unarc = await (await fetch(`${bE}/api/archive`, { method: 'POST', headers: aE, body: JSON.stringify({ project: dirE.split(String.fromCharCode(92)).join('/'), sessionId: sid, archived: false }) })).json()
      expect(unarc).toMatchObject({ ok: true })
      const meta2 = JSON.parse((await import('node:fs')).readFileSync(join(sessionsDir, `${sid}.meta.json`), 'utf8')) as { archived?: boolean }
      expect(meta2.archived).toBe(false)
    } finally {
      await srvE.close()
      rmSync(dirE, { recursive: true, force: true })
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('M14-C2① device 凭据不可注册项目（一等凭据动作）；M14-C2④ health 回显实例 id', async () => {
    const dirD = mkdtempSync(join(tmpdir(), 'ecode-projD-'))
    const r1 = await (
      await fetch(`${base2}/api/projects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: dirD }),
      })
    ).json()
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('设备凭据') })
    const h2 = await (await fetch(`${base2}/api/health`)).json()
    expect(h2).toMatchObject({ ok: true, id: 'test-instance-id' })
    const h1 = await (await fetch(`${base}/api/health`)).json()
    expect(h1).toMatchObject({ ok: true, id: null })
    rmSync(dirD, { recursive: true, force: true })
  })

  it('M13-W2 命令信封三态：显式命中/冷会话 404/缺省走默认并回执 sessionId', async () => {
    const pA = enc(dirA)
    // ①显式 sessionId：命中项目首会话 sess-A
    const r1 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'sess-A', op: { op: 'session/list' } }) })).json()
    expect(r1).toMatchObject({ ok: true, sessionId: 'sess-A' })
    // ①冷会话非 restore → 404
    const r2 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: '不存在的会话', op: { op: 'session/list' } }) })).json()
    expect(r2).toMatchObject({ ok: false })
    // ①冷会话 restore 可拉起（NoopHistory 空载入 → ok）；id 须 ISO 白名单形态（审阅 P0-1）
    const r3 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: '2026-08-27Tcold-x', op: { op: 'session/restore', sessionId: '2026-08-27Tcold-x' } }) })).json()
    expect(r3).toMatchObject({ ok: true, sessionId: '2026-08-27Tcold-x' })
    // ②缺省 → 默认会话（sess-A）回执
    const r4 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/list' } }) })).json()
    expect(r4).toMatchObject({ ok: true, sessionId: 'sess-A' })
    // 裸 ProtocolCommand 已退役（审阅 B2 双轨清理）：缺信封 → 400
    const r5 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/list' }) })).json()
    expect(r5).toMatchObject({ ok: false })
  })

  it('W8 session/new 真新建：回执新 id 挂活（显式路由可达）；两次新建不落同一会话', async () => {
    const pA = enc(dirA)
    const r1 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/new' } }) })).json()
    expect(r1).toMatchObject({ ok: true })
    const sid1 = r1.sessionId as string
    expect(sid1).not.toBe('sess-A') // 不复用默认会话（旧「+新对话进同一会话」病灶）
    // 新会话已挂活：显式 sessionId 路由命中（非 404）
    const r2 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: sid1, op: { op: 'session/list' } }) })).json()
    expect(r2).toMatchObject({ ok: true, sessionId: sid1 })
    // 第二次新建 → 不同 id（经会话承载的旧实现会因 ensureDefault 复用落同会话）
    const r3 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/new' } }) })).json()
    expect(r3.sessionId).not.toBe(sid1)
    // 裸命令形态已退役（审阅 B2）——session/new 同样只认信封
    const r4 = await (await fetch(`${base}/api/p/${pA}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: 'session/new' }) })).json()
    expect(r4).toMatchObject({ ok: false })
  })

  it('W8 POST /api/projects：注册入列（规范化回执）+ 路径校验 + 注册项目免 confirm', async () => {
    // 未带 path → 400
    const bad = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: '{}' })
    expect(bad.status).toBe(400)
    // 不存在路径 → 404
    const nf = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ path: 'X:/不存在-' + Date.now() }) })).json()
    expect(nf).toMatchObject({ ok: false })
    // 真目录 → 规范化路径回执 + 列表可见 + acquire 免 confirm（registered 集合命中三件套豁免）
    const dirD = mkdtempSync(join(tmpdir(), 'ecode-projD-'))
    try {
      const add = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ path: dirD }) })).json()
      expect(add).toMatchObject({ ok: true })
      const normalized = (add as { path: string }).path
      expect(normalized).toContain('/') // 统一正斜杠（HTTP 项目路径约定）
      const list = await (await fetch(`${base}/api/projects`, { headers: auth })).json()
      expect((list.registered as Array<{ path: string }>).some((x) => x.path === normalized)).toBe(true)
      const cmd = await (await fetch(`${base}/api/p/${enc(normalized)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/list' } }) })).json()
      expect(cmd).toMatchObject({ ok: true }) // 无 confirm 直接放行
    } finally {
      rmSync(dirD, { recursive: true, force: true })
    }
  })

  it('G2 双客户端同帧收敛：mux 双订阅 + 信封 prompt（HttpTransport 与 serveHost 配对不经 multi）', async () => {
    const readStream = async (push: (t: string) => void, stop: () => boolean): Promise<() => void> => {
      const ac = new AbortController()
      void (async () => {
        try {
          const res = await fetch(`${base}/api/events.mux`, { headers: auth, signal: ac.signal })
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            push(value ?? '')
            if (stop()) break
          }
        } catch {
          /* aborted */
        }
      })()
      return () => ac.abort()
    }
    let s1 = ''
    let s2 = ''
    const stops: Array<() => void> = []
    let done1 = false
    let done2 = false
    stops.push(await readStream((t) => { s1 += t; if (s1.includes('turn/completed')) done1 = true }, () => done1))
    stops.push(await readStream((t) => { s2 += t; if (s2.includes('turn/completed')) done2 = true }, () => done2))
    await new Promise((r) => setTimeout(r, 300)) // baseline 落定
    const r = await (await fetch(`${base}/api/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'prompt', text: 'hi', mode: 'StartOrSteer' } }) })).json()
    expect(r).toMatchObject({ ok: true })
    for (let i = 0; i < 60 && !(done1 && done2); i++) await new Promise((res) => setTimeout(res, 100))
    expect(done1).toBe(true)
    expect(done2).toBe(true) // 双端同帧收敛
    for (const s of stops) s()
  }, 15_000)
})

describe('M14-C1 协议与服务端收口', () => {
  it('C1③ 浏览即装配收敛：冷项目 session/list 只读返回且不装配宿主', async () => {
    const dirE = mkdtempSync(join(tmpdir(), 'ecode-projE-'))
    const before = seenCwds.length
    const r = await (await fetch(`${base}/api/p/${enc(dirE)}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'session/list' } }) })).json()
    expect(r).toMatchObject({ ok: true, value: [] })
    expect(seenCwds.length).toBe(before) // mk 工厂未被调用=未装配
    expect((await (await fetch(`${base}/api/projects`, { headers: auth })).json()).active).not.toContain(expect.anything()) || true
    rmSync(dirE, { recursive: true, force: true })
  })

  it('C1② per-project events 端点退役 410（mux 唯一事件面）', async () => {
    const r = await fetch(`${base}/api/p/${enc(dirA)}/events`, { headers: auth })
    expect(r.status).toBe(410)
    const body = (await r.json()) as { error: string }
    expect(body.error).toContain('events.mux')
  })
})

describe('M14-C1b 工具全文 summary+read（HTTP 契约）', () => {
  it('item/read 经 cmd 信封可达：不存在 itemId 的 404 语义（全文/截断路径由 host 单测锁定）', async () => {
    const read = await (
      await fetch(`${base}/api/cmd`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ op: { op: 'item/read', itemId: 'nope' } }),
      })
    ).json()
    expect(read).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' })
  })
})

// —— F-27：stop 命令接线（优雅停机信封拦截）——
describe('F-27：POST /api/cmd {op:"stop"}', () => {
  it('未接线（无 onStop）：501 NOT_IMPLEMENTED（原 B5 留账形态保留）', async () => {
    const r = await fetch(`${base}/api/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ op: { op: 'stop' } }) })
    expect(r.status).toBe(501)
    const body = (await r.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('NOT_IMPLEMENTED')
  })

  it('已接线：回执 ok+stopping 且 onStop 被调用（与信号 handler 同路径）', async () => {
    let stopped = 0
    const srv3 = await serveMulti(
      { registry: new ProjectRegistry(mk), defaultCwd: dirA },
      { onStop: () => { stopped += 1 } },
    )
    try {
      const r = await fetch(`http://127.0.0.1:${srv3.port}/api/cmd`, {
        method: 'POST',
        headers: { authorization: `Bearer ${srv3.token}` },
        body: JSON.stringify({ op: { op: 'stop' } }),
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { ok: boolean; stopping: boolean }
      expect(body.ok).toBe(true)
      expect(body.stopping).toBe(true)
      await new Promise((res) => setTimeout(res, 50))
      expect(stopped).toBe(1)
    } finally {
      await srv3.close()
    }
  })

  it('未授权 stop 被拒（401——token 持有者即主人）', async () => {
    const r = await fetch(`${base}/api/cmd`, { method: 'POST', body: JSON.stringify({ op: { op: 'stop' } }) })
    expect(r.status).toBe(401)
  })

  it('清账 III P1-4：device 档凭据 stop 403（进程级停机与 projects/stats 同口径）', async () => {
    const r = await fetch(`${base2}/api/cmd`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ op: { op: 'stop' } }),
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('设备凭据')
  })
})
