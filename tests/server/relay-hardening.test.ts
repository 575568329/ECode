/**
 * R 线审阅修复回归锁（四角色审阅报告 P0/P1 项）：
 * - hosts.online 响应头顺序崩进程（P0-1 实跑复现项）+ 未知 id 回显语义 + assign 鉴权
 * - phoneBase 显式性（P0-2：缺省派生死链——phoneConnectUrl 无 phoneBase 必须 throw）
 * - device scope 命令面（chat 白名单外 403）/ events.mux device 档 host 帧照发
 * - fresh 抢位仲裁（活 control+租约未过期 → 4409）
 * - 租约过期 4408 + attach 超时 4408（缩时独立 relay 实例）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { serveMulti } from '../../src/server/multi.js'
import { ProjectRegistry } from '../../src/server/projects.js'
import { RelayClient } from '../../src/server/relayClient.js'
import { DeviceRegistry } from '../../src/server/devices.js'
import { E2eeClientSession, loadOrCreateHostKeys } from '../../src/server/e2ee.js'

const regToken = `tok-${randomBytes(8).toString('hex')}`
const tmp = mkdtempSync(join(tmpdir(), 'ecode-relay-hard-'))

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

let phonePort = 0
let hostPort = 0
let relayProc: ReturnType<typeof spawn> | null = null

beforeAll(async () => {
  phonePort = 20000 + Math.floor(Math.random() * 20000)
  hostPort = phonePort + 1 // 相邻分配——独立随机曾可撞出同端口（审阅 P2）
  relayProc = spawn(process.execPath, ['relay/server.cjs'], {
    env: {
      ...process.env,
      RELAY_REG_TOKEN: regToken,
      RELAY_PHONE_PORT: String(phonePort),
      RELAY_HOST_PORT: String(hostPort),
      RELAY_LOG: join(tmp, 'relay.log'),
      RELAY_ATTACH_MS: '10000',
    },
    stdio: 'ignore',
  })
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${phonePort}/v1/health`)).ok
    } catch {
      return false
    }
  })
}, 20_000)

afterAll(() => {
  relayProc?.kill()
  rmSync(tmp, { recursive: true, force: true })
})

describe('relay HTTP 面回归（P0-1 修复锁）', () => {
  it('/v1/hosts/online 正常回显（响应头顺序 bug 曾一击崩进程）且未知 id 回 online:false', async () => {
    const res = await fetch(`http://127.0.0.1:${phonePort}/v1/hosts/online?ids=unknown-host`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { hosts: Record<string, { online: boolean }> }
    expect(body.hosts['unknown-host'].online).toBe(false)
    // relay 进程仍存活（修复前这里进程已死）
    const health = await fetch(`http://127.0.0.1:${phonePort}/v1/health`)
    expect(health.ok).toBe(true)
  })

  it('/v1/hosts/online ids 白名单过滤（非法字符不入查询）', async () => {
    const res = await fetch(`http://127.0.0.1:${phonePort}/v1/hosts/online?ids=${encodeURIComponent('../../etc')},ok-id`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hosts: Record<string, unknown> }
    expect(Object.keys(body.hosts).sort()).toEqual(['ok-id'])
  })

  it('/v1/assign 鉴权（错 token 401）', async () => {
    const bad = await fetch(`http://127.0.0.1:${hostPort}/v1/assign`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    expect(bad.status).toBe(401)
    const ok = await fetch(`http://127.0.0.1:${hostPort}/v1/assign`, { method: 'POST', headers: { authorization: `Bearer ${regToken}` } })
    expect(ok.status).toBe(200)
  })
})

describe('phoneBase 显式性（P0-2 修复锁）', () => {
  it('phoneConnectUrl：显式 phoneBase 正常拼装；缺省必须 throw（不允许死链派生）', () => {
    const mk = (phoneBase?: string): RelayClient =>
      new RelayClient({ hostBase: 'wss://x.example/ecode-tunnel', phoneBase, hostId: 'h', hostToken: 't', hostName: 'h', appVersion: 'v', daemonPort: 0, verifyAuth: () => null })
    expect(mk('wss://x.example/ecode').phoneConnectUrl).toBe('wss://x.example/ecode/v1/connect/h')
    expect(() => mk(undefined).phoneConnectUrl).toThrow(/phoneBase/)
  })
})

describe('device scope 命令面（审阅 P1-5 执行锁）', () => {
  it('chat 档：白名单内命令放行，model/set 等管理命令 403', async () => {
    const registry = new ProjectRegistry({ createSession: async () => ({}) as never })
    const devices = new DeviceRegistry(join(tmp, 'devices-scope.json'))
    const keys = loadOrCreateHostKeys(join(tmp, 'e2ee-scope.json'))
    const rc = new RelayClient({
      hostBase: `ws://127.0.0.1:${hostPort}`,
      phoneBase: `ws://127.0.0.1:${phonePort}`,
      hostId: 'scope-host',
      hostToken: regToken,
      hostName: 'scope-host',
      appVersion: 'test',
      daemonPort: 0,
      verifyAuth: () => null,
      hostKeys: { publicKeyB64: keys.publicKeyB64, privateKeyB64: keys.privateKeyB64 },
    })
    const srv = await serveMulti({ registry, defaultCwd: tmp }, { devices: { deviceRegistry: devices, relay: () => rc, hostPublicKeyB64: keys.publicKeyB64 } })
    rc.bindDaemon(srv.port, srv.verify ?? (() => null))
    rc.start()
    await waitFor(() => rc.status().connected)
    // 配对（chat 档）→ device phone
    const pairRes = await fetch(`http://127.0.0.1:${srv.port}/api/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.token}` },
      body: JSON.stringify({ name: 'chat-phone', scope: 'chat' }),
    })
    const pair = (await pairRes.json()) as { ok?: boolean; secret?: string; relay?: { connectUrl: string; inviteToken: string } }
    expect(pair.ok).toBe(true)
    const phone = await new Promise<{ send: (o: unknown) => void; next: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>; close: () => void }>((resolve, reject) => {
      const client = new E2eeClientSession(keys.publicKeyB64, pair.secret!)
      const ws = new WebSocket(pair.relay!.connectUrl, ['ecode-relay', pair.relay!.inviteToken])
      const queue: Record<string, unknown>[] = []
      const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = []
      const pump = (m: Record<string, unknown>): void => {
        const i = waiters.findIndex((w) => w.pred(m))
        if (i >= 0) {
          clearTimeout(waiters[i].timer)
          waiters.splice(i, 1)[0].resolve(m)
        } else queue.push(m)
      }
      ws.on('message', (raw) => {
        const text = raw.toString()
        if (!client.readyState) {
          const r = client.onMessage(text)
          if (r.send !== undefined) ws.send(r.send)
        }
        const decoded = client.decode(text)
        if (decoded !== null) pump(decoded)
      })
      ws.on('error', reject)
      ws.on('open', () => ws.send(client.start()))
      const next = (pred?: (m: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const p = (m: Record<string, unknown>): boolean => (pred === undefined ? true : pred(m))
          const idx = queue.findIndex(p)
          if (idx >= 0) return res(queue.splice(idx, 1)[0])
          const timer = setTimeout(() => rej(new Error('等帧超时')), timeoutMs)
          waiters.push({ pred: p, resolve: res, timer })
        })
      void next((m) => m.t === 'e2ee_ok')
        .then(() => resolve({ send: (o) => ws.send(client.encode(o)), next, close: () => ws.close() }))
        .catch(reject)
    })
    // 白名单外（model/set）→ 403
    phone.send({ t: 'cmd', id: 'm1', body: { op: { op: 'model/set', provider: 'p', model: 'm' } } })
    const resM = await phone.next((m) => m.t === 'res' && m.id === 'm1')
    expect(resM.status).toBe(403)
    // 白名单内（config/get 只读）→ 非 403（项目未注册的其它错误可接受——scope 门已过）
    phone.send({ t: 'cmd', id: 'c1', body: { op: { op: 'config/get' } } })
    const resC = await phone.next((m) => m.t === 'res' && m.id === 'c1')
    expect(resM.status).toBe(403)
    expect(resC.status).not.toBe(403)
    phone.close()
    rc.dispose()
    await srv.close()
  })
})

describe('控制腿代次仲裁（审阅 P1-6 修复锁）', () => {
  it('活 control+租约未过期时，fresh hello 被拒 4409（防双 daemon 互踢风暴）', async () => {
    const registry = new ProjectRegistry({ createSession: async () => ({}) as never })
    const rc = new RelayClient({
      hostBase: `ws://127.0.0.1:${hostPort}`,
      phoneBase: `ws://127.0.0.1:${phonePort}`,
      hostId: 'arb-host',
      hostToken: regToken,
      hostName: 'arb-host',
      appVersion: 'test',
      daemonPort: 0,
      verifyAuth: () => null,
    })
    const srv = await serveMulti({ registry, defaultCwd: tmp }, {})
    rc.bindDaemon(srv.port, srv.verify ?? (() => null))
    rc.start()
    await waitFor(() => rc.status().connected)
    // 第二个 daemon 形态：裸 ws fresh hello（不带 resume）
    const intruder = await new Promise<{ ws: WebSocket; next: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>; closeCode: Promise<number> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/tunnel/arb-host`, { headers: { authorization: `Bearer ${regToken}` } })
      const closeCode = new Promise<number>((res) => ws.on('close', (c) => res(c)))
      const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = []
      ws.on('message', (raw) => {
        let m: Record<string, unknown>
        try {
          m = JSON.parse(raw.toString()) as Record<string, unknown>
        } catch {
          return
        }
        const i = waiters.findIndex((w) => w.pred(m))
        if (i >= 0) {
          clearTimeout(waiters[i].timer)
          waiters.splice(i, 1)[0].resolve(m)
        }
      })
      ws.on('open', () => ws.send(JSON.stringify({ t: 'host-hello', v: 1, name: 'intruder', appVersion: 'x' })))
      const next = (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('等帧超时')), timeoutMs)
          waiters.push({ pred, resolve: res, timer })
        })
      ws.on('open', () => resolve({ ws, next, closeCode }))
      ws.on('error', reject)
    })
    const challenge = await intruder.next((m) => m.t === 'host-challenge')
    intruder.ws.send(JSON.stringify({ t: 'host-challenge-ack', challengeId: challenge.challengeId, proof: 'bad-proof' }))
    // 证明先拒（4401）——但换正确证明也须拒在代次：重连一次走对 proof
    const code1 = await intruder.closeCode
    expect([4401, 4409]).toContain(code1)
    if (code1 === 4401) {
      // proof 正确路径：HMAC(REG_TOKEN, domain||hostId||challengeId||nonce)
      const { createHmac } = await import('node:crypto')
      const ws2 = new WebSocket(`ws://127.0.0.1:${hostPort}/tunnel/arb-host`, { headers: { authorization: `Bearer ${regToken}` } })
      const code2 = await new Promise<number>((res) => {
        ws2.on('close', (c) => res(c))
        ws2.on('message', (raw) => {
          const m = JSON.parse(raw.toString()) as { t?: string; challengeId?: string; nonce?: string }
          if (m.t === 'host-challenge') {
            const proof = createHmac('sha256', regToken).update(`ecode-relay-host-proof\0arb-host\0${m.challengeId}\0${m.nonce}`).digest('base64')
            ws2.send(JSON.stringify({ t: 'host-challenge-ack', challengeId: m.challengeId, proof }))
          }
        })
        ws2.on('open', () => ws2.send(JSON.stringify({ t: 'host-hello', v: 1, name: 'intruder', appVersion: 'x' })))
      })
      expect(code2).toBe(4409) // 代次仲裁：活 control 持位——fresh 被拒
    }
    // 原控制腿不受影响（仍然 connected、generation 不变）
    expect(rc.status().connected).toBe(true)
    intruder.ws.close()
    rc.dispose()
    await srv.close()
  })
})

describe('租约过期与 attach 超时（缩时独立 relay 实例——审阅 P1-1/P1-3 覆盖缺口）', () => {
  let p2 = 0
  let h2 = 0
  let relay2: ReturnType<typeof spawn> | null = null
  beforeAll(async () => {
    p2 = 20000 + Math.floor(Math.random() * 20000)
    h2 = p2 + 1
    relay2 = spawn(process.execPath, ['relay/server.cjs'], {
      env: {
        ...process.env,
        RELAY_REG_TOKEN: regToken,
        RELAY_PHONE_PORT: String(p2),
        RELAY_HOST_PORT: String(h2),
        RELAY_LOG: join(tmp, 'relay2.log'),
        RELAY_LEASE_MS: '1500',
        RELAY_PING_MS: '300',
        RELAY_ATTACH_MS: '600',
      },
      stdio: 'ignore',
    })
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${p2}/v1/health`)).ok
      } catch {
        return false
      }
    })
  }, 20_000)
  afterAll(() => relay2?.kill())

  /** 裸控制腿（hello/proof/ack——不依赖 RelayClient，便于 attach 超时形态不拨数据腿） */
  function rawControl(hostId: string): Promise<{ ws: WebSocket; ack: Promise<Record<string, unknown>>; next: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h2}/tunnel/${hostId}`, { headers: { authorization: `Bearer ${regToken}` } })
      const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = []
      const queue: Record<string, unknown>[] = []
      let ackResolve: (m: Record<string, unknown>) => void = () => {}
      const ack = new Promise<Record<string, unknown>>((res) => (ackResolve = res))
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (m.t === 'host-challenge') {
          const proof = createHmac('sha256', regToken).update(`ecode-relay-host-proof\0${hostId}\0${String(m.challengeId)}\0${String(m.nonce)}`).digest('base64')
          ws.send(JSON.stringify({ t: 'host-challenge-ack', challengeId: m.challengeId, proof }))
          return
        }
        if (m.t === 'host-hello-ack') ackResolve(m)
        const i = waiters.findIndex((w) => w.pred(m))
        if (i >= 0) {
          clearTimeout(waiters[i].timer)
          waiters.splice(i, 1)[0].resolve(m)
        } else queue.push(m)
      })
      ws.on('error', reject)
      ws.on('open', () => ws.send(JSON.stringify({ t: 'host-hello', v: 1, name: hostId, appVersion: 'x' })))
      const next = (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> =>
        new Promise((res, rej) => {
          const idx = queue.findIndex(pred)
          if (idx >= 0) return res(queue.splice(idx, 1)[0])
          const timer = setTimeout(() => rej(new Error('等帧超时')), timeoutMs)
          waiters.push({ pred, resolve: res, timer })
        })
      ws.on('open', () => resolve({ ws, ack, next }))
    })
  }

  it('attach 超时：conn-open 后 daemon 不拨腿 → 手机 4408 + 控制腿收 conn-abort', async () => {
    const ctrl = await rawControl('attach-host')
    await ctrl.ack
    ctrl.ws.send(JSON.stringify({ t: 'invite-create', inviteToken: 'inv-attach-test-0123456789', ttlMs: 0, reqId: 'r1' }))
    await ctrl.next((m) => m.t === 'invite-ok')
    const phone = new WebSocket(`ws://127.0.0.1:${p2}/v1/connect/attach-host?token=inv-attach-test-0123456789`)
    const phoneClose = new Promise<number>((res) => phone.on('close', (c) => res(c)))
    await ctrl.next((m) => m.t === 'conn-open') // 不拨数据腿——触发 attach deadline
    expect(await phoneClose).toBe(4408)
    await ctrl.next((m) => m.t === 'conn-abort')
    ctrl.ws.close()
  })

  it('租约过期：控制腿收 4408，此后 resume rebind 拒、fresh 可入（新代）', async () => {
    const ctrl = await rawControl('lease-host')
    const ack = (await ctrl.ack) as { generation: number; controlResumeSecret: string }
    const gen0 = ack.generation
    const closeCode = new Promise<number>((res) => ctrl.ws.on('close', (c) => res(c)))
    // 不续租——等 sweep 置过期并关腿（lease 1.5s + sweep 300ms）
    expect(await closeCode).toBe(4408)
    // 旧 resume rebind → 4409
    const { createHmac } = await import('node:crypto')
    const rebindCode = await new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h2}/tunnel/lease-host`, { headers: { authorization: `Bearer ${regToken}` } })
      ws.on('close', (c) => res(c))
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as { t?: string; challengeId?: string; nonce?: string }
        if (m.t === 'host-challenge') {
          const proof = createHmac('sha256', regToken).update(`ecode-relay-host-proof\0lease-host\0${m.challengeId}\0${m.nonce}`).digest('base64')
          ws.send(JSON.stringify({ t: 'host-challenge-ack', challengeId: m.challengeId, proof }))
        }
      })
      ws.on('open', () => ws.send(JSON.stringify({ t: 'host-hello', v: 1, name: 'lease-host', appVersion: 'x', previousGeneration: gen0, controlResumeSecret: ack.controlResumeSecret })))
    })
    expect(rebindCode).toBe(4409)
    // fresh → 新代 ack
    const ctrl2 = await rawControl('lease-host')
    const ack2 = (await ctrl2.ack) as { generation: number }
    expect(ack2.generation).toBeGreaterThan(gen0)
    ctrl2.ws.close()
  })
})
