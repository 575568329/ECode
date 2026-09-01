/**
 * R 线：配对服务面（src/cli/pair.ts 与 TUI /pair 命令共用——命令面跑在 TUI 进程，
 * 与 daemon 同机，直接 DeviceRegistry + daemon HTTP 组装）。
 *
 * 双形态：
 * - daemon 在跑 → POST /api/devices（活注入+relay invite）→ 组装完整 offer（钉公钥/中继段/
 *   项目快照）→ 二维码+深链；
 * - daemon 不在 → 离线形态（仅写 devices.json，daemon 下次启动注入；无中继段——打印提示）。
 */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DeviceRegistry, probeRunningDaemon, type RunningDaemon } from './devices.js'

const require = createRequire(import.meta.url)

interface QrcodeTerminal {
  generate: (text: string, opts?: { small?: boolean }, cb?: (out: string) => void) => void
}

let qrcode: QrcodeTerminal | null = null
try {
  qrcode = require('qrcode-terminal') as QrcodeTerminal
} catch {
  qrcode = null // 依赖缺失不阻断（链接文本兜底）
}

/** 终端二维码文本（qrcode-terminal small 模式——▄▀█ 半块字符，每行 2 终端行；回调取串不碰 stdout） */
export function renderQrText(text: string): string {
  if (qrcode === null) return ''
  let out = ''
  try {
    qrcode.generate(text, { small: true }, (s) => {
      out = s
    })
  } catch {
    return '' // 依赖异常不阻断——面板回落链接文案
  }
  return out
}

export interface PairingResult {
  deviceId: string
  name: string
  scope: 'chat' | 'full'
  secret: string
  /** 完整 offer（中继段/钉公钥/项目快照——离线形态 undefined） */
  offer?: Record<string, unknown>
  /** 手机浏览器打开的配对深链（离线形态 undefined） */
  link?: string
  /** 终端二维码文本（离线形态 ''） */
  qrText: string
  /** 是否经运行中 daemon（活注入——否则离线形态） */
  viaDaemon: boolean
}

interface DaemonPairResponse {
  ok?: boolean
  error?: string
  device?: { deviceId: string; name: string; scope: string }
  secret?: string
  daemonPubKeyB64?: string
  projects?: unknown[]
  webOrigin?: string
  relay?: { connectUrl: string; hostId: string; inviteToken: string; expiresAt: number } | null
}

/** offer projects 归一字符串数组（multi 的 listKnown 对象形态/字符串双兼容——web 白屏前车） */
function normalizeProjects(projects: unknown): string[] {
  return (Array.isArray(projects) ? projects : [])
    .map((p) => (typeof p === 'string' ? p : (p as { path?: string } | null)?.path))
    .filter((p): p is string => typeof p === 'string' && p !== '')
}

/** 页面链接 scheme 归一（webOrigin 是 wss:——浏览器打不开 wss 页面，实机浏览器测试前车） */
function pageOrigin(webOrigin: string | undefined): string {
  return (webOrigin ?? '').replace(/\/$/, '').replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
}

/** 组装配对深链（与 web DevicesPanel/CLI 同构——契约由 pairing 测试锁） */
export function buildPairingLink(offer: Record<string, unknown>): string {
  const origin = pageOrigin(offer.webOrigin as string | undefined)
  const payload = Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url')
  return `${origin}/#pairing=${payload}`
}

/** 生成配对（daemon 在跑走 HTTP 活注入；否则离线写注册表） */
export async function createPairingFull(
  name: string,
  scope: 'chat' | 'full' = 'chat',
  note?: string,
  opts?: { regPath?: string },
): Promise<PairingResult> {
  const deviceName = name !== '' ? name : `设备-${randomBytes(2).toString('hex')}`
  const daemon: RunningDaemon | null = await probeRunningDaemon(opts?.regPath)
  if (daemon !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: JSON.stringify({ name: deviceName, scope, note }),
        signal: AbortSignal.timeout(8000), // relay invite 经控制腿往返——留裕量
      })
      const r = (await res.json()) as DaemonPairResponse
      if (res.ok && r.ok === true && r.device !== undefined && typeof r.secret === 'string') {
        const offer: Record<string, unknown> = {
          v: 1,
          deviceId: r.device.deviceId,
          name: r.device.name,
          scope: r.device.scope,
          secret: r.secret,
          daemonPubKeyB64: r.daemonPubKeyB64,
          projects: normalizeProjects(r.projects),
          webOrigin: r.webOrigin,
          relay: r.relay,
        }
        // relay 不在线（daemon 起了但中继链路断）→ offer 不带 relay 段：局域网形态可用，
        // 异地形态不可用——如实降级并提示（不静默给一张连不上的码）
        const hasRelay = typeof r.relay?.connectUrl === 'string' && r.relay.connectUrl !== ''
        const link = hasRelay ? buildPairingLink(offer) : undefined
        return {
          deviceId: r.device.deviceId,
          name: r.device.name,
          scope: r.device.scope as 'chat' | 'full',
          secret: r.secret,
          offer,
          link,
          qrText: link !== undefined ? renderQrText(link) : '',
          viaDaemon: true,
        }
      }
      // daemon 应答异常（非中断性）——落离线形态
    } catch {
      /* daemon 探测已过但配对请求失败（控制腿重连窗等）——落离线形态 */
    }
  }
  const entry = new DeviceRegistry(opts?.regPath !== undefined ? join(dirname(opts.regPath), 'devices.json') : undefined).create(
    deviceName,
    scope,
    note,
  )
  return { deviceId: entry.deviceId, name: entry.name, scope: entry.scope, secret: entry.secret, qrText: '', viaDaemon: false }
}

/** 配对结果全文（TUI /pair 与 CLI pair 输出同构） */
export function formatPairingResult(r: PairingResult): string {
  const lines: string[] = [`✓ 设备已配对：${r.name}（${r.deviceId}）${r.viaDaemon ? '' : '（离线形态）'}`]
  if (r.link !== undefined && r.link !== '') {
    lines.push('', '手机相机/微信扫二维码（或把链接发给手机浏览器打开）——自动完成配对：', '')
    if (r.qrText !== '') lines.push(r.qrText, '')
    lines.push(`  ${r.link}`)
  } else {
    lines.push('', '配对令牌（per-device，泄露可单独吊销）：', `  ${r.secret}`)
    if (!r.viaDaemon) {
      lines.push('', '注意：离线形态（daemon 未在跑）——需重启 serve 后才认此设备；且无中继段，手机异地接入请 daemon 在跑时重新 ecode pair。')
    } else {
      lines.push('', '注意：relay 未连接——此配对仅限局域网直接访问 daemon；异地接入请 relay 在线后重新配对。')
    }
  }
  lines.push('', `权限：${r.scope === 'full' ? '全功能' : '对话+只读（chat）'}——吊销：/devices revoke ${r.deviceId} 或 ecode devices revoke ${r.deviceId}`)
  return lines.join('\n')
}
