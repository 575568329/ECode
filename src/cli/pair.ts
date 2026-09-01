/**
 * R1/R2：`ecode pair` / `ecode devices` 命令面（M14 产品化线 R 方案 §5.2，D1 拍板：终端先行）。
 *
 * pair 双形态（R2 起）：
 * - daemon 在跑（server.json 健康）→ POST /api/devices（primary token 鉴权）：设备凭据活注入
 *   （无需重启 daemon）+ relay 在线时返回 relay 段（connectUrl/invite）——手机扫码即经中继接入；
 * - 无 daemon → 离线形态：只写 devices.json，daemon 下次启动注入（打印提示）。
 *
 * offer 打印：URL（#pairing= 承载——fragment 不进代理日志/Referer）+ 机读 JSON（QR 用）+ 令牌明文。
 * devices 命令面：list（表格）/ revoke <deviceId>（优先走运行中 daemon——同步 relay 断连与活凭据摘除）。
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { DeviceRegistry, devicesPath } from '../server/devices.js'
import { formatOfferQr } from './pairQr.js'

export interface PairResult {
  deviceId: string
  name: string
  secret: string
  scope: 'chat' | 'full'
  /** daemon 在跑时的完整 offer（relay 段/项目快照——R2 起） */
  offer?: Record<string, unknown>
}

/** 生成配对（命令面与测试共用）——daemon 在跑时走 HTTP（活注入+relay offer），否则离线写文件 */
export async function createPairing(name: string, scope: 'chat' | 'full' = 'chat', note?: string): Promise<PairResult> {
  const daemon = await probeDaemon()
  if (daemon !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: JSON.stringify({ name, scope, note }),
        signal: AbortSignal.timeout(8000), // relay invite 经控制腿往返——留出裕量
      })
      const r = (await res.json()) as { ok?: boolean; error?: string; device?: { deviceId: string; name: string; scope: string }; secret?: string; [k: string]: unknown }
      if (res.ok && r.ok === true && r.device !== undefined && typeof r.secret === 'string') {
        return {
          deviceId: r.device.deviceId,
          name: r.device.name,
          secret: r.secret,
          scope: r.device.scope as 'chat' | 'full',
          // daemonPubKeyB64 必须进 offer（钉公钥 T2——实机部署曾漏：multi 返回了但 offer 组装丢弃，
          // 手机端 D4 强制加密在 connect 时才拒，用户拿到的是一张注定连不上的二维码）
          // projects 归一为字符串数组（multi 回 listKnown 对象形态——web 端按字符串渲染曾白屏，实机浏览器测试抓获）
          offer: { v: 1, deviceId: r.device.deviceId, name: r.device.name, scope: r.device.scope, secret: r.secret, daemonPubKeyB64: r.daemonPubKeyB64, projects: (Array.isArray(r.projects) ? r.projects : []).map((p) => (typeof p === 'string' ? p : (p as { path?: string })?.path)).filter((x): x is string => typeof x === 'string'), webOrigin: r.webOrigin, relay: r.relay },
        }
      }
      process.stderr.write(`daemon 配对失败（HTTP ${res.status}${r.error !== undefined ? `：${r.error}` : ''}）——退回离线形态\n`)
    } catch (e) {
      process.stderr.write(`daemon 配对不可达（${e instanceof Error ? e.message : String(e)}）——退回离线形态\n`)
    }
  }
  const registry = new DeviceRegistry()
  const entry = registry.create(name, scope, note)
  return { deviceId: entry.deviceId, name: entry.name, secret: entry.secret, scope: entry.scope }
}

/** 运行中 daemon 探测（server.json + /api/health 身份核验——killServeByReg 同款防陈旧 PID） */
async function probeDaemon(): Promise<{ port: number; token: string } | null> {
  try {
    const regPath = join(homedir(), '.ecode', 'server.json')
    if (!existsSync(regPath)) return null
    const reg = JSON.parse(readFileSync(regPath, 'utf8')) as { pid: number; port: number; token: string; id?: string }
    process.kill(reg.pid, 0)
    const res = await fetch(`http://127.0.0.1:${reg.port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const h = (await res.json()) as { ok?: boolean; id?: string }
    if (h.ok !== true || (reg.id !== undefined && h.id !== reg.id)) return null
    return { port: reg.port, token: reg.token }
  } catch {
    return null
  }
}

/** offer 文本（打印给用户——#pairing= 深链由手机 web 消费；QR 随行） */
export function formatOffer(r: PairResult, webOrigin = ''): string {
  // 页面链接必须 http(s)（浏览器打不开 wss: 页面——手机扫码曾因此失败，实机浏览器测试抓获）；
  // offer 载荷里的 connectUrl 保持 wss（WebSocket 语义）
  const rawBase = (webOrigin !== '' ? webOrigin : r.offer?.webOrigin as string ?? '').replace(/\/$/, '')
  const base = rawBase.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
  const lines = [
    `✓ 设备已配对：${r.name}（${r.deviceId}）`,
    ``,
    `手机访问（浏览器打开——深链自动完成配对；或手动输入令牌）：`,
  ]
  if (base !== '') {
    const payload = r.offer ?? { v: 1, secret: r.secret, name: r.name, webOrigin: base }
    const link = `${base}/#pairing=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    lines.push(`  ${link}`)
    lines.push('')
    lines.push(formatOfferQr(link))
  } else {
    lines.push(`  （未检测到 web 源——局域网形态在 daemon 侧打印的 Mobile URL 打开后输入令牌）`)
  }
  lines.push(
    ``,
    `配对令牌（per-device，泄露可单独吊销）：`,
    `  ${r.secret}`,
    ``,
    `权限：${r.scope === 'full' ? '全功能' : '对话+只读（chat）'}——吊销：ecode devices revoke ${r.deviceId}`,
  )
  if (r.offer === undefined) {
    lines.push(``, `注意：离线形态下运行中的 daemon 需重启后才会认新设备凭据（ecode serve stop && ecode serve）。`)
  }
  return lines.join('\n')
}

export async function runPair(args: string[]): Promise<number> {
  const name = args[0] ?? `设备-${randomBytes(2).toString('hex')}`
  const scope = args.includes('--full') ? ('full' as const) : ('chat' as const)
  const note = `${process.platform}/${hostname()}`
  const r = await createPairing(name, scope, note)
  process.stdout.write(`${formatOffer(r)}\n`)
  return 0
}

export async function runDevices(args: string[]): Promise<number> {
  const daemon = await probeDaemon()
  if (args[0] === 'revoke') {
    const id = args[1]
    if (id === undefined) {
      process.stderr.write('用法：ecode devices revoke <deviceId>\n')
      return 1
    }
    // 优先走 daemon（同步 relay 断连+活凭据摘除——本地文件删不掉运行中 daemon 的记忆）
    if (daemon !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
          body: JSON.stringify({ deviceId: id }),
          signal: AbortSignal.timeout(5000),
        })
        const r = (await res.json()) as { ok?: boolean; error?: string }
        if (res.ok && r.ok === true) {
          process.stdout.write(`✓ 已吊销 ${id}（运行中 daemon 即时生效——下一请求 401）\n`)
          return 0
        }
        process.stderr.write(`daemon 吊销失败（HTTP ${res.status}${r.error !== undefined ? `：${r.error}` : ''}）\n`)
        return 1
      } catch (e) {
        process.stderr.write(`daemon 不可达（${e instanceof Error ? e.message : String(e)}）——仅删本地注册表\n`)
      }
    }
    const ok = new DeviceRegistry().revoke(id)
    process.stdout.write(ok ? `✓ 已吊销 ${id}${daemon === null ? '（下一请求即 401）' : ''}\n` : `✗ 未找到设备 ${id}\n`)
    return ok ? 0 : 1
  }
  let list: Array<{ deviceId: string; name: string; scope: string; pairedAt: string; relayInvite?: { expiresAt: number } }>
  if (daemon !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, {
        headers: { authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(3000),
      })
      const r = (await res.json()) as { ok?: boolean; devices?: Array<{ deviceId: string; name: string; scope: string; pairedAt: string; relayInvite?: { expiresAt: number } }> }
      list = r.devices ?? []
    } catch {
      list = new DeviceRegistry().list()
    }
  } else {
    list = new DeviceRegistry().list()
  }
  if (list.length === 0) {
    process.stdout.write(`尚无配对设备（ecode pair 配对）。注册表：${devicesPath()}\n`)
    return 0
  }
  process.stdout.write(`配对设备（${list.length}）：\n`)
  for (const d of list) {
    const relayMark = d.relayInvite !== undefined ? '  [relay invite]' : ''
    process.stdout.write(`  ${d.deviceId}  ${d.name}  [${d.scope}]  配对于 ${d.pairedAt}${relayMark}\n`)
  }
  return 0
}

void randomBytes
