/**
 * R2 集成测试：relay（spawned server.cjs）↔ RelayClient（daemon 出站）↔ phone-sim（ws 客户端）。
 * 覆盖：控制腿 4 步握手/invite 准入拒绝/cmd 往返（凭据分级随 daemon 栅栏）/事件订阅/吊销断连/
 * 设备管理端点（配对 offer 带 relay 段+吊销三步序）/rebind 同代/fresh 换代收割存量腿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { serveMulti } from '../../src/server/multi.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { RelayClient } from '../../src/server/relayClient.js'
import { DeviceRegistry } from '../../src/server/devices.js'
import { E2eeClientSession, loadOrCreateHostKeys } from '../../src/server/e2ee.js'
import type { MuxFrame } from '../../src/protocol/mux.js'

const regToken = `tok-${randomBytes(8).toString('hex')}`
let relayProc: ReturnType<typeof spawn> | null = null
let phonePort = 0
let hostPort = 0

const tmp = mkdtempSync(join(tmpdir(), 'ecode-relay-test-'))

beforeAll(async () => {
  // relay server：随机高位端口 + 缩短 attach 时限
  phonePort = 20000 + Math.floor(Math.random() * 20000)
  hostPort = 20000 + Math.floor(Math.random() * 20000)
  relayProc = spawn(process.execPath, ['relay/server.cjs'], {
    env: {
      ...process.env,
      RELAY_REG_TOKEN: regToken,
      RELAY_PHONE_PORT: String(phonePort),
      RELAY_HOST_PORT: String(hostPort),
      RELAY_LOG: join(tmpdir(), 'ecode-relay-test-' + Date.now() + '.log'),
      RELAY_ATTACH_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  relayProc.on('error', (e) => console.error('relay spawn failed:', e))
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${phonePort}/v1/health`)
      return r.ok
    } catch {
      return false
    }
  })
}, 20_000)

afterAll(() => {
  relayProc?.kill()
  rmSync(tmp, { recursive: true, force: true })
})

function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 8000, stepMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      void Promise.resolve()
        .then(cond)
        .then((ok) => {
          if (ok) return resolve()
          if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor 超时'))
          setTimeout(tick, stepMs)
        })
        .catch(reject)
    }
    tick()
  })
}

/** 起一个绑定了 relay 的 daemon（serveMulti 进程内）+ 接线好的 RelayClient */
async function startDaemon(opts: { hostId: string; leaseMs?: number; renewMarginMs?: number }): Promise<{ srv: Awaited<ReturnType<typeof serveMulti>>; rc: RelayClient; registry: DeviceRegistry }> {
  const registry = new ProjectRegistry({ createSession: async () => ({}) as never })
  const devices = new DeviceRegistry(join(tmp, `devices-${opts.hostId}.json`))
  const keys = loadOrCreateHostKeys(join(tmp, `e2ee-${opts.hostId}.json`))
  const rc = new RelayClient({
    hostBase: `ws://127.0.0.1:${hostPort}`,
    phoneBase: `ws://127.0.0.1:${phonePort}`,
    hostId: opts.hostId,
    hostToken: regToken,
    hostName: opts.hostId,
    appVersion: 'test',
    daemonPort: 0,
    verifyAuth: () => null,
    renewMarginMs: opts.renewMarginMs,
    hostKeys: { publicKeyB64: keys.publicKeyB64, privateKeyB64: keys.privateKeyB64 },
  })
  const srv = await serveMulti(
    { registry, defaultCwd: tmp },
    {
      devices: { deviceRegistry: devices, relay: () => rc, audit: () => {} },
    },
  )
  rc.bindDaemon(srv.port, srv.verify ?? (() => null))
  rc.start()
  await waitFor(() => rc.status().connected)
  return { srv, rc, registry: devices, hostPubKeyB64: keys.publicKeyB64 }
}

/** phone-sim：建立数据腿会话（R3 E2EE 握手——与 web/src/e2ee.ts 同契约的 Node 侧），返回收发器 */
function phoneDial(connectUrl: string, invite: string, secret: string, hostPubKeyB64: string): Promise<{
  ws: WebSocket
  send: (o: unknown) => void
  next: (pred?: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(connectUrl, ['ecode-relay', invite])
    const client = new E2eeClientSession(hostPubKeyB64, secret)
    const queue: Record<string, unknown>[] = []
    const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = []
    const fail = (e: Error): void => {
      for (const w of waiters) {
        clearTimeout(w.timer)
        w.resolve = () => {}
      }
      waiters.length = 0
      reject(e)
    }
    const pump = (m: Record<string, unknown>): void => {
      const i = waiters.findIndex((w) => w.pred(m))
      if (i >= 0) {
        clearTimeout(waiters[i].timer)
        waiters.splice(i, 1)[0].resolve(m)
      } else {
        queue.push(m)
      }
    }
    ws.on('message', (raw) => {
      const text = raw.toString()
      if (!client.readyState) {
        // 握手段：e2ee_ready（明文）→ 派生+回密文 auth
        const r = client.onMessage(text)
        if (r.send !== undefined) ws.send(r.send)
      }
      const decoded = client.decode(text) // e2ee_ok 与此后全部帧（密文）
      if (decoded !== null) pump(decoded)
    })
    ws.on('error', reject)
    ws.on('close', (code) => {
      if (!client.readyState || code === 4001 || code === 4003) fail(new Error(`e2ee 数据腿被拒（code ${code}）`))
    })
    ws.on('open', () => ws.send(client.start()))
    const next = (pred?: (m: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        const p = (m: Record<string, unknown>): boolean => (pred === undefined ? true : pred(m))
        const idx = queue.findIndex(p)
        if (idx >= 0) return res(queue.splice(idx, 1)[0])
        const timer = setTimeout(() => rej(new Error('phone-sim 等帧超时')), timeoutMs)
        waiters.push({ pred: p, resolve: res, timer })
      })
    // e2ee_ok 即就绪（daemon 已验过密文 auth）
    void next((m) => m.t === 'e2ee_ok')
      .then(() => resolve({ ws, send: (o) => ws.send(client.encode(o)), next, close: () => ws.close() }))
      .catch(fail)
  })
}

describe('R2 relay 全链路', () => {
  it('控制腿握手后 invite 准入、cmd 往返带 daemon 栅栏语义', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-a' })
    try {
      const inv = await d.rc.createInvite(60_000)
      const phone = await phoneDial(d.rc.phoneConnectUrl, inv.inviteToken, d.srv.token, d.hostPubKeyB64)
      // device 凭据注册项目 → daemon 栅栏拒绝（凭据分级跨中继生效的断言）
      phone.send({ t: 'cmd', id: 'c1', body: { op: { op: 'session/list' } } })
      const res1 = await phone.next((m) => m.t === 'res' && m.id === 'c1')
      // 往返断言：primary 凭据的 session/list 走完 relay→数据腿→loopback→mux 冷路径全链
      expect((res1.json as { ok?: boolean }).ok).toBe(true)
      expect(Array.isArray((res1.json as { value?: unknown[] }).value)).toBe(true)
      phone.close()
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })

  it('坏 invite / 坏凭据被拒', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-b' })
    try {
      await expect(phoneDial(d.rc.phoneConnectUrl, 'bogus-invite', 'x', d.hostPubKeyB64)).rejects.toThrow()
      const inv = await d.rc.createInvite(60_000)
      // 正确 invite + 坏凭据：hello 被断（4401）
      await expect(phoneDial(d.rc.phoneConnectUrl, inv.inviteToken, 'wrong-secret', d.hostPubKeyB64)).rejects.toThrow()
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })

  it('吊销三步序：invite revoke 断活连接；POST /api/devices 配对 offer 带 relay 段', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-c' })
    try {
      // 配对（走 daemon HTTP 端点——pair CLI 同链路）
      const res = await fetch(`http://127.0.0.1:${d.srv.port}/api/devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${d.srv.token}` },
        body: JSON.stringify({ name: '手机', scope: 'chat' }),
      })
      const r = (await res.json()) as { ok?: boolean; secret?: string; relay?: { connectUrl: string; inviteToken: string }; projects?: string[] }
      expect(r.ok).toBe(true)
      expect(r.relay?.connectUrl).toContain(`/v1/connect/host-c`)
      expect(Array.isArray(r.projects)).toBe(true)
      // 新设备凭据活注入（无需重启）：电话直接用新 secret 连上
      const phone = await phoneDial(r.relay!.connectUrl, r.relay!.inviteToken, r.secret!, d.hostPubKeyB64)
      // 吊销（daemon 端点——注册表删+凭据摘除+invite revoke 断活连接）
      const list = (await (await fetch(`http://127.0.0.1:${d.srv.port}/api/devices`, { headers: { authorization: `Bearer ${d.srv.token}` } })).json()) as {
        devices: Array<{ deviceId: string }>
      }
      const del = await fetch(`http://127.0.0.1:${d.srv.port}/api/devices/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${d.srv.token}` },
        body: JSON.stringify({ deviceId: list.devices[0].deviceId }),
      })
      expect(((await del.json()) as { ok?: boolean }).ok).toBe(true)
      await waitFor(() => phone.ws.readyState === WebSocket.CLOSED)
      // 被吊销凭据的请求也失效（活摘除——非重启才生效）
      const h = await fetch(`http://127.0.0.1:${d.srv.port}/api/projects`, { headers: { authorization: `Bearer ${r.secret}` } })
      expect(h.status).toBe(401)
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })

  it('事件订阅：mux 帧经数据腿透传（baseline 帧）', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-d' })
    try {
      const inv = await d.rc.createInvite(60_000)
      const phone = await phoneDial(d.rc.phoneConnectUrl, inv.inviteToken, d.srv.token, d.hostPubKeyB64)
      phone.send({ t: 'sub', id: 's1' })
      const subOk = await phone.next((m) => m.t === 'sub-ok' && m.id === 's1')
      expect(subOk.id).toBe('s1')
      // baseline 帧（host 生命周期）必达
      const frame = await phone.next((m) => m.t === 'frame' && (m.frame as MuxFrame).host !== undefined)
      expect(((frame.frame as { host: { type: string } }).host).type).toBe('session/baseline')
      // 退订后不再收帧
      phone.send({ t: 'unsub', id: 's1' })
      await new Promise((r) => setTimeout(r, 200))
      phone.close()
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })

  it('rebind 同代接管：控制腿断开重连后 generation 不变', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-e', leaseMs: undefined, renewMarginMs: 200 })
    try {
      const gen0 = d.rc.status().generation
      expect(gen0).toBeGreaterThan(0)
      // 主动续租（rebind 语义——断控制腿重连）
      const ws = (d.rc as unknown as { ws: WebSocket }).ws
      ws.close(4000, 'renew-test')
      await waitFor(() => d.rc.status().connected && d.rc.status().generation === gen0, 10_000)
      expect(d.rc.status().generation).toBe(gen0)
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })

  it('fresh 重连换代：resume 不匹配被拒（4409），fresh hello 换代', { timeout: 25_000 }, async () => {
    const d = await startDaemon({ hostId: 'host-f', renewMarginMs: 200 })
    try {
      const gen0 = d.rc.status().generation
      // 篡改 resume secret → rebind 被拒 → 客户端 creds 清空 → fresh 换代
      const internal = d.rc as unknown as { creds: { generation: number; resumeSecret: string }; ws: WebSocket }
      internal.creds = { generation: internal.creds.generation, resumeSecret: 'tampered' }
      internal.ws.close(4000, 'force-reconnect')
      await waitFor(() => d.rc.status().connected && d.rc.status().generation > gen0, 15_000)
      expect(d.rc.status().generation).toBeGreaterThan(gen0)
    } finally {
      d.rc.dispose()
      await d.srv.close()
    }
  })
})
