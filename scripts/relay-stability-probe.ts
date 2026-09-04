/**
 * 手机连接稳定性压测（真实手机等价模拟：经公网 relay 的 E2EE 数据腿客户端）：
 *  ① 配对（offer 完整性）
 *  ② E2EE 连接握手
 *  ③ 基线 20 次 cmd 往返（成功率+延迟分布）
 *  ④ 重连风暴 ×10（快速断开重连）
 *  ⑤ 沉默 35s（越过控制腿心跳窗）后 cmd 仍通
 *  ⑥⑦ 双客户端抢位（fresh hello 仲裁：老连接被踢）
 *  ⑧ 持久 invite 复用连接
 * 压测设备自动吊销清理。
 * 用法：npx tsx scripts/relay-stability-probe.ts [--server wss://nodetime.cn] [--token REG_TOKEN] [--hostId win-dev-01]
 */
import WebSocket from 'ws'
import { E2eeClientSession } from '../src/server/e2ee.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (n: string): string | undefined => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const SERVER = argOf('--server') ?? 'wss://nodetime.cn'
const REG_TOKEN = argOf('--token') ?? '4cc9285748e0d9d6477b9f5f10d3e7f5'
const HOST_ID = argOf('--hostId') ?? 'win-dev-01'
const CONNECT_URL = `${SERVER}/ecode/v1/connect/${HOST_ID}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const results: Array<{ name: string; ok: boolean; note?: string }> = []
const check = (name: string, ok: boolean, note = ''): void => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}

interface Phone {
  ws: WebSocket
  client: E2eeClientSession
  send: (o: unknown) => void
  next: (pred?: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}

function openPhone(secret: string, hostPubKeyB64: string, inviteToken: string): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const client = new E2eeClientSession(hostPubKeyB64, secret)
    const ws = new WebSocket(CONNECT_URL, ['ecode-relay', inviteToken])
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
        const timer = setTimeout(() => rej(new Error('phone-sim 等帧超时')), timeoutMs)
        waiters.push({ pred: p, resolve: res, timer })
      })
    void next((m) => m.t === 'e2ee_ok', 15000)
      .then(() =>
        resolve({
          ws,
          client,
          send: (o) => ws.send(client.encode(o)),
          next,
          close: () => ws.close(),
        }),
      )
      .catch(reject)
  })
}

async function main(): Promise<void> {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const reg = JSON.parse(fs.readFileSync(`${os.homedir()}/.ecode/server.json`, 'utf8')) as { port: number; token: string }
  // 压测设备走临时 home 的独立 daemon？不——直接用本机 daemon 配对（压测后吊销）
  const pairRes = await fetch(`http://127.0.0.1:${reg.port}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ name: `stability-${Date.now() % 100000}` }),
  })
  const offer = (await pairRes.json()) as { ok?: boolean; secret?: string; daemonPubKeyB64?: string; relay?: { inviteToken: string; connectUrl: string } }
  check('① 配对（offer 完整）', offer.ok === true && typeof offer.secret === 'string' && typeof offer.daemonPubKeyB64 === 'string' && offer.relay !== undefined)
  if (offer.secret === undefined || offer.daemonPubKeyB64 === undefined || offer.relay === undefined) process.exit(1)

  // —— ② E2EE 连接 ——
  let ph: Phone
  try {
    ph = await openPhone(offer.secret, offer.daemonPubKeyB64, offer.relay.inviteToken)
    check('② E2EE 连接握手（e2ee_ok）', ph.client.readyState)
  } catch (e) {
    check('② E2EE 连接握手（e2ee_ok）', false, String(e).slice(0, 80))
    process.exit(1)
  }

  // —— ③ 基线 20 次 cmd 往返 ——
  let okCount = 0
  const lats: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now()
    try {
      ph.send({ t: 'cmd', id: `probe-${i}`, body: { op: { op: 'session/list' } } })
      const resp = await ph.next((m) => m.t === 'res' && m.id === `probe-${i}`, 15000)
      if ((resp.json as { ok?: boolean })?.ok === true) {
        okCount++
        lats.push(Date.now() - t0)
      }
    } catch {
      /* 该轮失败计 0 */
    }
  }
  const avg = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0
  check('③ 基线 20 次 cmd 往返', okCount >= 18, `${okCount}/20 成功，延迟 min/avg/max = ${lats.length > 0 ? `${Math.min(...lats)}/${avg}/${Math.max(...lats)}` : '-'}ms`)

  // —— ④ 重连风暴 ×10 ——
  ph.close()
  let stormOk = 0
  for (let i = 0; i < 10; i++) {
    try {
      const p = await openPhone(offer.secret, offer.daemonPubKeyB64, offer.relay.inviteToken)
      stormOk++
      p.close()
      await sleep(100)
    } catch {
      await sleep(200)
    }
  }
  check('④ 重连风暴 ×10', stormOk >= 9, `${stormOk}/10 快速重连成功`)

  // —— ⑤ 沉默 35s 后仍通 ——
  let phQuiet: Phone | null = null
  try {
    phQuiet = await openPhone(offer.secret, offer.daemonPubKeyB64, offer.relay.inviteToken)
  } catch {
    check('⑤ 沉默 35s 后仍通', false, '连接失败')
  }
  if (phQuiet !== null) {
    console.log('  … 沉默 35s（越过控制腿 ping 窗）…')
    await sleep(35_000)
    try {
      phQuiet.send({ t: 'cmd', id: 'after-silent', body: { op: { op: 'session/list' } } })
      const r = await phQuiet.next((m) => m.t === 'res' && m.id === 'after-silent', 15000)
      check('⑤ 沉默 35s 后仍通', (r.json as { ok?: boolean })?.ok === true)
    } catch (e) {
      check('⑤ 沉默 35s 后仍通', false, String(e).slice(0, 60))
    }
  }

  // —— ⑥⑦ 多设备并发在线（数据腿多连接语义——抢位仲裁 4409 只作用于 daemon 控制腿防冒名，
  // 手机数据腿本就是 maxLegs=8 共存设计：两台手机同 invite 同时在线是产品语义） ——
  try {
    const phNew = await openPhone(offer.secret, offer.daemonPubKeyB64, offer.relay.inviteToken)
    check('⑥ 第二设备并发在线', phNew.client.readyState)
    // 并发期两腿各自 cmd 都通（服务正确路由——老腿不因新腿上线而失联）
    let bothOk = false
    try {
      phQuiet?.send({ t: 'cmd', id: 'dual-old', body: { op: { op: 'session/list' } } })
      phNew.send({ t: 'cmd', id: 'dual-new', body: { op: { op: 'session/list' } } })
      const [rOld, rNew] = await Promise.all([
        phQuiet ? phQuiet.next((m) => m.t === 'res' && m.id === 'dual-old', 15000) : Promise.reject(new Error('无老腿')),
        phNew.next((m) => m.t === 'res' && m.id === 'dual-new', 15000),
      ])
      bothOk = (rOld.json as { ok?: boolean })?.ok === true && (rNew.json as { ok?: boolean })?.ok === true
    } catch { bothOk = false }
    check('⑦ 双腿并发 cmd 各自正确路由', bothOk)
    phNew.close()
  } catch (e) {
    check('⑥ 第二设备并发在线', false, String(e).slice(0, 60))
    check('⑦ 双腿并发 cmd 各自正确路由', false, '前置失败')
  }

  // —— ⑧ 持久 invite 复用 ——
  try {
    const ph5 = await openPhone(offer.secret, offer.daemonPubKeyB64, offer.relay.inviteToken)
    check('⑧ 持久 invite 复用连接（吊销前多次配对同 invite）', ph5.client.readyState)
    ph5.close()
  } catch (e) {
    check('⑧ 持久 invite 复用连接（吊销前多次配对同 invite）', false, String(e).slice(0, 60))
  }

  // 清理压测设备
  try {
    const list = (await (await fetch(`http://127.0.0.1:${reg.port}/api/devices`, { headers: { authorization: `Bearer ${reg.token}` } })).json()) as { devices: Array<{ deviceId: string; name: string }> }
    for (const d of list.devices) {
      if (d.name.startsWith('stability-')) {
        await fetch(`http://127.0.0.1:${reg.port}/api/devices/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
          body: JSON.stringify({ deviceId: d.deviceId }),
        })
        console.log(`  [cleanup] 已吊销 ${d.name}`)
      }
    }
  } catch { /* 清理失败不掩盖主结果 */ }
  void tmpdir
  void join
  void mkdtempSync

  const failed = results.filter((x) => !x.ok)
  console.log(`\n# 结论：${results.length - failed.length}/${results.length} 过${failed.length > 0 ? '，失败：' + failed.map((f) => f.name).join(' / ') : ''}`)
  process.exit(failed.length > 0 ? 1 : 0)
}

void main().catch((e) => {
  console.error('driver error:', e)
  process.exit(1)
})
