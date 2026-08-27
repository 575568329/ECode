/**
 * M13-W3 mux 单流测试（方案 §3.3）：一条 SSE 汇所有项目所有会话——
 * baseline 帧/信封事件帧/project·added 动态接入/过滤钩子（预留②）/非 loopback 强制密码（预留③）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveMulti } from '../../src/server/multi.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { ProjectHost } from '../../src/host/project.js'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import type { MuxFrame } from '../../src/protocol/mux.js'
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
const mkConv = (cwd: string): HostDeps => {
  const reg = new ToolRegistryImpl()
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 10,
  }
  void cwd
  return {
    providerRegistry: { getByType: () => new P() } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
  }
}

const dirA = mkdtempSync(join(tmpdir(), 'ecode-muxA-'))
const dirB = mkdtempSync(join(tmpdir(), 'ecode-muxB-'))
const fwd = (p: string): string => p.split(String.fromCharCode(92)).join('/')

const registry = new ProjectRegistry({
  createSession: (cwd) => {
    const p = new ProjectHost({ createConversation: () => mkConv(cwd), cwd: fwd(cwd) })
    p.ensure('sess-mux-A')
    return p
  },
  lockDir: join(tmpdir(), `ecode-muxlock-${Date.now()}`),
})
registry.register(dirA)
registry.register(dirB)

let srv: Awaited<ReturnType<typeof serveMulti>>
let base: string
beforeAll(async () => {
  srv = await serveMulti({ registry, defaultCwd: dirA })
  base = `http://127.0.0.1:${srv.port}`
})
afterAll(async () => {
  await srv.close()
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

/** 读一条 mux 帧（SSE data: 行解析为 MuxFrame；跳过 ping 注释与空行） */
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, acc: { buf: string }): Promise<MuxFrame> {
  for (;;) {
    const lineIdx = acc.buf.indexOf('\ndata: ')
    const lineEnd = acc.buf.indexOf('\n\n', lineIdx + 1)
    if (lineIdx !== -1 && lineEnd !== -1) {
      const raw = acc.buf.slice(lineIdx + 7, lineEnd)
      acc.buf = acc.buf.slice(lineEnd + 2)
      return JSON.parse(raw) as MuxFrame
    }
    const chunk = await reader.read()
    if (chunk.value !== undefined) acc.buf += new TextDecoder().decode(chunk.value)
    if (chunk.done && acc.buf.indexOf('\ndata: ') === -1) throw new Error('stream closed')
  }
}

const connect = async (): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; frames: MuxFrame[]; done: () => void }> => {
  const res = await fetch(`${base}/api/events.mux`, { headers: { authorization: `Bearer ${srv.token}` } })
  if (res.body === null) throw new Error('no body')
  const reader = res.body.getReader()
  const acc = { buf: '' }
  const frames: MuxFrame[] = []
  let stopped = false
  const pump = (async () => {
    try {
      for (;;) {
        if (stopped) return
        const chunk = await reader.read()
        if (chunk.value !== undefined) acc.buf += new TextDecoder().decode(chunk.value)
        if (chunk.done) return
        // 增量收割完整帧
        for (;;) {
          const i = acc.buf.indexOf('\ndata: ')
          const e = acc.buf.indexOf('\n\n', i + 1)
          if (i === -1 || e === -1) break
          frames.push(JSON.parse(acc.buf.slice(i + 7, e)) as MuxFrame)
          acc.buf = acc.buf.slice(e + 2)
        }
      }
    } catch {
      /* closed */
    }
  })()
  void pump
  return { reader, frames, done: () => { stopped = true; void reader.cancel() } }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('M13-W3 mux 单流', () => {
  it('连接三连：baseline（活项目+活会话清单）在首帧', async () => {
    // 先物化 A（mux 连接前 acquire——baseline 只含活项目）
    // M14-C1③：session/list 已不走装配（只读）——用缺省路由 prompt 前的 session/new 显式挂活项目
    await fetch(`${base}/api/p/${encodeURIComponent(fwd(dirA))}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ op: { op: 'session/new' } }) })
    const c = await connect()
    await wait(600)
    const baseline = c.frames.find((f) => 'host' in f && f.host.type === 'session/baseline')
    expect(baseline).toBeDefined()
    if (baseline !== undefined && 'host' in baseline && baseline.host.type === 'session/baseline') {
      expect(baseline.host.projects.length).toBeGreaterThanOrEqual(1)
      expect(baseline.host.sessions.some((s) => s.sessionId === 'sess-mux-A')).toBe(true)
    }
    c.done()
  })

  it('信封事件帧：项目 A prompt → {project, sessionId, ev:delta}；项目 B 事件同流可达', async () => {
    const c = await connect()
    await wait(400)
    const fwdA = fwd(dirA)
    const fwdB = fwd(dirB)
    // A 触发一轮（cmd 路由缺省=A 默认会话）
    const r = await (await fetch(`${base}/api/p/${encodeURIComponent(fwdA)}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ sessionId: 'sess-mux-A', op: { op: 'prompt', text: 'hi', mode: 'StartOrSteer' } }) })).json()
    expect(r).toMatchObject({ ok: true })
    // B 也触发（拉起+prompt——先 list 拉起再 prompt 太繁，直接 restore 拉起冷会话）
    await fetch(`${base}/api/p/${encodeURIComponent(fwdB)}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ op: { op: 'session/new' } }) })
    await wait(900)
    const aFrames = c.frames.filter((f) => 'project' in f && f.project === fwdA && f.sessionId === 'sess-mux-A')
    expect(aFrames.some((f) => 'ev' in f && f.ev.type === 'delta')).toBe(true) // A 的 delta 经信封带维度
    // B 项目动态接入：连接后首次拉起 → project/added 帧（created 早于连接，added 是接入信号）
    const bSeen = c.frames.some((f) => 'host' in f && f.host.type === 'project/added' && f.host.project === fwdB)
    expect(bSeen).toBe(true)
    c.done()
  }, 10_000)

  it('过滤钩子（预留②）：muxFilter 丢弃的帧不到客户端', async () => {
    const srvF = await serveMulti(
      {
        registry: new ProjectRegistry({
          createSession: (cwd) => {
            const p = new ProjectHost({ createConversation: () => mkConv(cwd), cwd: fwd(cwd) })
            p.ensure('sess-f')
            return p
          },
          lockDir: join(tmpdir(), `ecode-muxlock-f-${Date.now()}`),
        }),
        defaultCwd: dirA,
      },
      { muxFilter: (f) => !('ev' in f && f.ev.type === 'delta') },
    )
    const res = await fetch(`http://127.0.0.1:${srvF.port}/api/events.mux`, { headers: { authorization: `Bearer ${srvF.token}` } })
    const reader = res.body!.getReader()
    const acc = { buf: '' }
    const frames: MuxFrame[] = []
    const dead = { stop: false }
    void (async () => {
      for (;;) {
        if (dead.stop) return
        const ch = await reader.read()
        if (ch.value !== undefined) acc.buf += new TextDecoder().decode(ch.value)
        if (ch.done) return
        for (;;) {
          const i = acc.buf.indexOf('\ndata: ')
          const e = acc.buf.indexOf('\n\n', i + 1)
          if (i === -1 || e === -1) break
          frames.push(JSON.parse(acc.buf.slice(i + 7, e)) as MuxFrame)
          acc.buf = acc.buf.slice(e + 2)
        }
      }
    })()
    await wait(300)
    void readFrame // 引用保活
    expect(frames.some((f) => 'ev' in f && f.ev.type === 'delta')).toBe(false) // delta 被过滤
    expect(frames.some((f) => 'host' in f && f.host.type === 'session/baseline')).toBe(true) // baseline 放行
    dead.stop = true
    void reader.cancel()
    await srvF.close()
  }, 10_000)

  it('非 loopback 绑定强制密码（预留③）：无密码拒绝启动；有密码 Bearer 可用（M14-C2② Basic 形态退役）', async () => {
    await expect(
      serveMulti({ registry, defaultCwd: dirA }, { host: '0.0.0.0' }),
    ).rejects.toThrow('密码')
    const srvP = await serveMulti({ registry, defaultCwd: dirA }, { host: '0.0.0.0', password: 'pw123' })
    const ok = await fetch(`http://127.0.0.1:${srvP.port}/api/health`)
    expect(ok.status).toBe(200) // health 免鉴权
    const denied = await fetch(`http://127.0.0.1:${srvP.port}/api/projects`)
    expect(denied.status).toBe(401)
    const allowed = await fetch(`http://127.0.0.1:${srvP.port}/api/projects`, {
      headers: { authorization: `Bearer pw123` },
    })
    expect(allowed.status).toBe(200) // 密码作为第二凭据（lan-password 级——D13 凭据条目化）
    await srvP.close()
  })

  it('M14-C4④ /api/stats：Bearer 可用返回聚合（days 窗口裁剪 byDay）；无 token 401；缓存落注入路径不碰真实 home', async () => {
    const statsDir = mkdtempSync(join(tmpdir(), 'ecode-stats-'))
    const cachePath = join(statsDir, 'stats-cache.json')
    const srvS = await serveMulti({ registry, defaultCwd: dirA }, { sessionsDir: statsDir, statsCachePath: cachePath })
    const denied = await fetch(`http://127.0.0.1:${srvS.port}/api/stats`)
    expect(denied.status).toBe(401)
    const res = await fetch(`http://127.0.0.1:${srvS.port}/api/stats?days=3`, {
      headers: { authorization: `Bearer ${srvS.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; days: number; sessions: number; byDay: unknown[]; totals: { input: number } }
    expect(body.ok).toBe(true)
    expect(body.days).toBe(3) // 窗口参数透传
    expect(body.sessions).toBe(0) // 空 sessions 目录：聚合空但结构完整
    expect(body.byDay).toEqual([])
    expect(body.totals.input).toBe(0)
    // 带非数字 days 走缺省 7（防 NaN 崩端点）
    const resDefault = await fetch(`http://127.0.0.1:${srvS.port}/api/stats?days=abc`, {
      headers: { authorization: `Bearer ${srvS.token}` },
    })
    expect(((await resDefault.json()) as { days: number }).days).toBe(7)
    await srvS.close()
    rmSync(statsDir, { recursive: true, force: true })
  })
})

describe('M14-C1④ mux per-client 过滤管线', () => {
  it('?sessionId= 声明只收该会话 ev 帧；host 生命周期帧照发', async () => {
    // 两会话挂活同一项目，过滤连接只订 sess-mux-A
    await fetch(`${base}/api/p/${encodeURIComponent(fwd(dirA))}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ op: { op: 'session/new' } }) }) // 现仅保底挂活项目
    const filtered = await fetch(`${base}/api/events.mux?sessionId=sess-mux-A&canAnswer=1`, { headers: { authorization: `Bearer ${srv.token}` } })
    if (filtered.body === null) throw new Error('no body')
    const frames: MuxFrame[] = []
    const acc = { buf: '' }
    const reader = filtered.body.getReader()
    let stopped = false
    const pump = (async () => {
      try {
        for (;;) {
          if (stopped) return
          const chunk = await reader.read()
          if (chunk.value !== undefined) acc.buf += new TextDecoder().decode(chunk.value)
          if (chunk.done) return
          for (;;) {
            const i = acc.buf.indexOf('\ndata: ')
            const e = acc.buf.indexOf('\n\n', i + 1)
            if (i === -1 || e === -1) break
            frames.push(JSON.parse(acc.buf.slice(i + 7, e)) as MuxFrame)
            acc.buf = acc.buf.slice(e + 2)
          }
        }
      } catch {
        /* closed */
      }
    })()
    void pump
    // A 会话 prompt → delta 到达（过滤命自身）
    await fetch(`${base}/api/p/${encodeURIComponent(fwd(dirA))}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ sessionId: 'sess-mux-A', op: { op: 'prompt', text: 'hi', mode: 'StartOrSteer' } }) })
    for (let i = 0; i < 50 && !frames.some((f) => 'ev' in f && f.ev.type === 'delta'); i++) await wait(100)
    expect(frames.some((f) => 'ev' in f && f.sessionId === 'sess-mux-A' && f.ev.type === 'delta')).toBe(true)
    // B 项目真建会话并 prompt（真实产生 ev 帧）→ 过滤连接不收 B 的 ev 帧；host 帧不受影响
    const newB = (await (await fetch(`${base}/api/p/${encodeURIComponent(fwd(dirB))}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ op: { op: 'session/new' } }) })).json()) as { ok: boolean; sessionId?: string }
    expect(newB.ok).toBe(true)
    await fetch(`${base}/api/p/${encodeURIComponent(fwd(dirB))}/cmd`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}` }, body: JSON.stringify({ sessionId: newB.sessionId, op: { op: 'prompt', text: 'yo', mode: 'StartOrSteer' } }) })
    for (let i = 0; i < 50 && !frames.some((f) => 'host' in f && f.host.type === 'project/added'); i++) await wait(100)
    expect(frames.some((f) => 'ev' in f && f.sessionId === newB.sessionId)).toBe(false)
    expect(frames.some((f) => 'host' in f)).toBe(true) // 生命周期帧照发
    stopped = true
    void reader.cancel()
  }, 15_000)
})
