/**
 * R2/R3 外网端到端探针：relay（本地 spawn 或 --remote 远程）↔ daemon（tmp home 隔离）↔
 * phone-sim（WS+E2EE）。部署后跑 `npx tsx scripts/relay-e2e-probe.ts --server wss://nodetime.cn
 * --token <REG_TOKEN>` 验证公网全链路；不带参数则本地 spawn relay 全闭环。
 *
 * 断言：①控制腿在线 ②配对 offer 带 relay 段+公钥 ③数据腿 E2EE 握手 ④cmd 往返 ⑤事件订阅
 * ⑥控制腿重连（rebind/重拨）后数据腿自愈。
 * 安全：daemon 全程跑在临时 USERPROFILE（禁碰真实 ~/.ecode——agent-replay 教训）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { RelayClient } from '../src/server/relayClient.js'
import { ProjectRegistry } from '../src/server/projects.js'
import { serveMulti } from '../src/server/multi.js'
import { DeviceRegistry } from '../src/server/devices.js'
import { E2eeClientSession, loadOrCreateHostKeys } from '../src/server/e2ee.js'

const args = process.argv.slice(2)
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const remoteServer = argOf('--server')
const regToken = argOf('--token') ?? `probe-${randomBytes(8).toString('hex')}`
const hostId = argOf('--hostId') ?? `probe-${randomBytes(3).toString('hex')}`

const results: Array<{ name: string; ok: boolean; note?: string }> = []
const check = (name: string, ok: boolean, note?: string): void => {
  results.push({ name, ok, note })
  console.log(`${ok ? '✓' : '✗'} ${name}${note !== undefined ? ` — ${note}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true
    await sleep(120)
  }
  return false
}

async function main(): Promise<void> {
  // —— relay：本地 spawn 或远程 ——
  let relayProc: ReturnType<typeof spawn> | null = null
  let phoneBase: string
  let hostBase: string
  if (remoteServer !== undefined) {
    phoneBase = `${remoteServer.replace(/\/$/, '')}/ecode`
    hostBase = `${remoteServer.replace(/\/$/, '')}/ecode-tunnel`
    console.log(`远程 relay：${remoteServer}（hostId=${hostId}）`)
  } else {
    const phonePort = 20000 + Math.floor(Math.random() * 20000)
    const hostPort = phonePort + 1
    relayProc = spawn(process.execPath, ['relay/server.cjs'], {
      env: { ...process.env, RELAY_REG_TOKEN: regToken, RELAY_PHONE_PORT: String(phonePort), RELAY_HOST_PORT: String(hostPort), RELAY_LOG: join(tmpdir(), 'relay-probe.log') },
      stdio: 'ignore',
    })
    phoneBase = `ws://127.0.0.1:${phonePort}`
    hostBase = `ws://127.0.0.1:${hostPort}`
    const up = await waitFor(async () => {
      try {
        return (await fetch(`${phoneBase.replace('ws', 'http')}/v1/health`)).ok
      } catch {
        return false
      }
    })
    if (!up) {
      check('relay 启动', false)
      process.exit(2)
    }
    console.log(`本地 relay：${hostBase}`)
  }

  // —— daemon：临时 USERPROFILE 隔离 + serveMulti 进程内（探针只验 relay 面，不 spawn 真 serve 进程）——
  const tmpHome = mkdtempSync(join(tmpdir(), 'ecode-relay-probe-'))
  const keys = loadOrCreateHostKeys(join(tmpHome, 'keys', 'e2ee.json'))
  const registry = new ProjectRegistry({ createSession: async () => ({}) as never })
  const devices = new DeviceRegistry(join(tmpHome, 'devices.json'))
  const rc = new RelayClient({
    hostBase,
    phoneBase,
    hostId,
    hostToken: regToken,
    hostName: 'probe-host',
    appVersion: 'probe',
    daemonPort: 0,
    verifyAuth: () => null,
    hostKeys: { publicKeyB64: keys.publicKeyB64, privateKeyB64: keys.privateKeyB64 },
  })
  const srv = await serveMulti({ registry, defaultCwd: tmpHome }, { devices: { deviceRegistry: devices, relay: () => rc, hostPublicKeyB64: keys.publicKeyB64 } })
  void srv
  rc.bindDaemon(srv.port, srv.verify ?? (() => null))
  rc.start()
  check('① 控制腿在线（host-hello-ack）', await waitFor(() => rc.status().connected))

  // —— 配对 offer（POST /api/devices 直连 daemon——pair CLI 同链路）——
  const pairRes = await fetch(`http://127.0.0.1:${srv.port}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.token}` },
    body: JSON.stringify({ name: 'probe-phone' }),
  })
  const offer = (await pairRes.json()) as { ok?: boolean; secret?: string; relay?: { connectUrl: string }; daemonPubKeyB64?: string }
  check('② 配对 offer 带 relay 段+E2EE 公钥', offer.ok === true && offer.relay !== undefined && typeof offer.daemonPubKeyB64 === 'string')

  // —— phone-sim：E2EE 数据腿 + cmd 往返 + 事件订阅 ——
  const phone = await new Promise<{ ws: WebSocket; client: E2eeClientSession; send: (o: unknown) => void; next: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>> }>((resolve, reject) => {
    // auth 用 primary token（session/list 冷路径需要非 device 凭据——device 栅栏语义由 vitest 覆盖）
    const client = new E2eeClientSession(offer.daemonPubKeyB64!, srv.token)
    const ws = new WebSocket(offer.relay!.connectUrl, ['ecode-relay', (offer as { relay?: { inviteToken?: string } }).relay!.inviteToken!])
    const queue: Array<Record<string, unknown>> = []
    const waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }> = []
    const pump = (m: Record<string, unknown>): void => {
      const i = waiters.findIndex((w) => w.pred(m))
      if (i >= 0) {
        clearTimeout(waiters[i].timer)
        waiters.splice(i, 1)[0].resolve(m)
      } else queue.push(m)
    }
    ws.on('open', () => ws.send(client.start()))
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
    ws.on('close', (code) => {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer)
        w.resolve({ __closed: String(code) })
      }
    })
    const next = (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        const idx = queue.findIndex(pred)
        if (idx >= 0) return res(queue.splice(idx, 1)[0])
        const timer = setTimeout(() => rej(new Error('phone-sim 等帧超时')), timeoutMs)
        waiters.push({ pred, resolve: res, timer })
      })
    void next((m) => m.t === 'e2ee_ok')
      .then(() => resolve({ ws, client, send: (o) => ws.send(client.encode(o)), next }))
      .catch(reject)
  })
  check('③ 数据腿 E2EE 握手（e2ee_ok）', phone.ws.readyState === WebSocket.OPEN)

  phone.send({ t: 'cmd', id: 'p1', body: { op: { op: 'session/list' } } })
  const res1 = await phone.next((m) => m.t === 'res' && m.id === 'p1')
  check('④ cmd 往返（relay→数据腿→daemon）', (res1.json as { ok?: boolean })?.ok === true)

  phone.send({ t: 'sub', id: 's1' })
  const gotBaseline = await phone
    .next((m) => m.t === 'frame' && (m.frame as { host?: { type?: string } })?.host?.type === 'session/baseline', 8000)
    .then(() => true)
    .catch(() => false)
  check('⑤ 事件订阅（mux baseline 帧透传）', gotBaseline)

  // —— 控制腿重连 → 数据腿自愈 ——
  const oldWs = (rc as unknown as { ws: WebSocket | null }).ws
  oldWs?.close(4000, 'probe-reconnect')
  const reconnected = await waitFor(() => rc.status().connected)
  await sleep(500)
  phone.send({ t: 'cmd', id: 'p2', body: { op: { op: 'session/list' } } })
  let res2: Record<string, unknown> | null = null
  try {
    res2 = await phone.next((m) => m.t === 'res' && m.id === 'p2', 8000)
  } catch {
    res2 = null
  }
  check('⑥ 控制腿重连后数据腿可用', reconnected && res2 !== null && (res2.json as { ok?: boolean })?.ok === true)

  // —— 清理 ——
  phone.ws.close()
  rc.dispose()
  await srv.close()
  relayProc?.kill()
  rmSync(tmpHome, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 断言通过${failed.length > 0 ? ` —— 失败：${failed.map((f) => f.name).join('、')}` : ' —— 全部通过'}`)
  process.exit(failed.length > 0 ? 1 : 0)
}

void main().catch((e) => {
  console.error('探针异常：', e instanceof Error ? e.message : String(e))
  process.exit(2)
})
