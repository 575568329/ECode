/**
 * R4：`ecode wechat-login`——微信 ClawBot（iLink）扫码登录终端流程。
 *
 * 流程：get_bot_qrcode（终端 QR+URL）→ 用户微信扫码确认 → 轮询 get_qrcode_status 至
 * confirmed → 打印 bot_token 与 config.wechat 配置指引（不自动改用户 config——密钥落盘
 * 形态由用户掌握；对齐「打印不写盘」的 pair offer 口径）。
 *
 * 固定头（iLink 契约）：AuthorizationType: ilink_bot_token + X-WECHAT-UIN 随机（防重放）。
 */
import { randomInt } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

interface QrcodeTerminal {
  generate: (text: string, opts?: { small?: boolean }) => void
}

let qrcode: QrcodeTerminal | null = null
try {
  qrcode = require('qrcode-terminal') as QrcodeTerminal
} catch {
  qrcode = null
}

const API_BASE = 'https://ilinkai.weixin.qq.com'
const POLL_INTERVAL_MS = 2_000
const LOGIN_TIMEOUT_MS = 3 * 60_000

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorizationtype: 'ilink_bot_token',
    'x-wechat-uin': Buffer.from(String(randomInt(0, 0xffffffff))).toString('base64'),
  }
}

function printQr(text: string): void {
  if (qrcode === null) return
  try {
    qrcode.generate(text, { small: true })
  } catch {
    /* 降级为纯 URL */
  }
}

export async function runWechatLogin(): Promise<number> {
  process.stdout.write('微信 ClawBot 扫码登录（iLink 官方协议）\n\n')
  let qrId = ''
  let qrUrl = ''
  try {
    const res = await fetch(`${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: headers(), signal: AbortSignal.timeout(15_000) })
    const body = (await res.json()) as { qrcode?: string; url?: string; qrcode_img_content?: string }
    qrId = String(body.qrcode ?? '')
    qrUrl = String(body.url ?? body.qrcode_img_content ?? '')
  } catch (e) {
    process.stderr.write(`✗ 获取登录二维码失败：${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
  if (qrId === '') {
    process.stderr.write('✗ iLink 未返回二维码（服务可能不可用或接口变更）\n')
    return 1
  }
  if (qrUrl !== '') {
    process.stdout.write('请用微信扫码确认：\n\n')
    printQr(qrUrl)
    process.stdout.write(`  ${qrUrl}\n\n`)
  }
  const t0 = Date.now()
  while (Date.now() - t0 < LOGIN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (process.stdout.isTTY) process.stdout.write(`  等待扫码确认…（${Math.round((Date.now() - t0) / 1000)}s）\r`)
    try {
      const res = await fetch(`${API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrId)}`, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await res.json()) as { status?: string; bot_token?: string }
      if (body.status === 'confirmed' && typeof body.bot_token === 'string' && body.bot_token !== '') {
        process.stdout.write(`\n✓ 登录成功。\n\nbot_token：\n  ${body.bot_token}\n\n写入 ~/.ecode/config.json 激活：\n`)
        process.stdout.write(`  "wechat": { "botToken": "${body.bot_token}", "allowUsers": ["<你的微信 user id，形如 xxx@im.wechat>"] }\n`)
        process.stdout.write(`\nallowUsers 为白名单（缺省/空=拒绝所有——安全缺省）。user id 可在首次消息的 daemon 日志（wechat_denied 事件）里看到。\n然后重启 serve（ecode serve stop && ecode serve）。\n`)
        return 0
      }
    } catch {
      /* 单次轮询失败继续 */
    }
  }
  process.stderr.write('\n✗ 超时未确认——重新执行 ecode wechat-login\n')
  return 1
}
