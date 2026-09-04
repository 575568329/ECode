/**
 * 二维码扫码效果验证（jsqr 解码回读——等价手机相机扫描）：
 *  A. 终端 QR（qrcode-terminal 半块字符渲染进 canvas → jsqr 解码）内容 == 配对深链
 *  B. 深链结构有效性（https/主机/路径/#pairing base64url 可解析、字段完整）
 *  C. 字符集（无空格/引号——URL 转义不破坏扫码）
 * 走真 daemon 配对（压测设备自动吊销）。
 * 用法：npx tsx scripts/qr-verify.ts
 */
import jsQR from 'jsqr'
import { createPairingFull, type PairingResult } from '../src/server/pairing.js'
import { homedir } from 'node:os'

const results: Array<{ name: string; ok: boolean; note?: string }> = []
const check = (name: string, ok: boolean, note = ''): void => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`)
}

const result: PairingResult = await createPairingFull(`qr-verify-${Date.now() % 100000}`, 'chat')
const link = result.link ?? ''

if (link === '' || result.qrText === '') {
  console.log('✗ 前置失败：daemon 不在跑或 relay 离线（无深链/QR）——先起 ecode serve')
  process.exit(1)
}

// —— A: 终端 QR 解码回读（qrcode-terminal small 模式：▀▄█ 半块，每文本行 = 2 模块行） ——
const rows = result.qrText.split('\n').filter((l) => l.length > 0)
const cols = Math.max(...rows.map((r) => r.length))
const SCALE = 8
const W = cols * SCALE
const H = rows.length * SCALE * 2
// 手写 RGBA 位图（jsqr 输入；无 canvas 原生依赖——Windows 编译问题绕行）
const data = new Uint8ClampedArray(W * H * 4).fill(255)
const fillBlack = (px: number, py: number): void => {
  for (let dy = 0; dy < SCALE; dy++) {
    for (let dx = 0; dx < SCALE; dx++) {
      const i = ((py + dy) * W + (px + dx)) * 4
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
    }
  }
}
for (let y = 0; y < rows.length; y++) {
  for (let x = 0; x < cols; x++) {
    const ch = rows[y]?.[x] ?? ' '
    if (ch === '█') {
      fillBlack(x * SCALE, y * SCALE * 2)
      fillBlack(x * SCALE, y * SCALE * 2 + SCALE)
    } else if (ch === '▄') {
      fillBlack(x * SCALE, y * SCALE * 2 + SCALE)
    } else if (ch === '▀') {
      fillBlack(x * SCALE, y * SCALE * 2)
    }
  }
}
const decoded = jsQR(data, W, H)

check('A1 终端 QR 可解码（jsqr 等价相机扫描）', decoded !== null, decoded === null ? 'jsqr 未识别——半块展开或静区不足' : `格式=${decoded.dataFormat}`)
if (decoded !== null) {
  check('A2 解码内容 == 配对深链（逐字节一致）', decoded.data === link, decoded.data === link ? `${link.length} 字节一致` : `解码 ${decoded.data.length}B ≠ 期望 ${link.length}B`)
}

// —— B: 深链结构 ——
try {
  const u = new URL(link)
  check('B1 scheme https（浏览器/微信相机可打开）', u.protocol === 'https:')
  check('B2 host 正确', u.host === 'nodetime.cn', u.host)
  check('B3 路径 /ecode/', u.pathname.replace(/\/$/, '') === '/ecode', u.pathname)
  check('B4 #pairing= 前缀', u.hash.startsWith('#pairing='))
  const payload = decodeURIComponent(u.hash.slice('#pairing='.length))
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
    v?: number
    deviceId?: string
    secret?: string
    daemonPubKeyB64?: string
    relay?: { connectUrl?: string; inviteToken?: string }
  }
  check(
    'B5 深链 JSON 字段完整（v/deviceId/secret/公钥/relay）',
    json.v === 1 && typeof json.deviceId === 'string' && typeof json.secret === 'string' && typeof json.daemonPubKeyB64 === 'string' && typeof json.relay?.connectUrl === 'string' && typeof json.relay.inviteToken === 'string',
    `secret ${(json.secret ?? '').length}B`,
  )
  check('B6 relay connectUrl 与扫码主机一致', typeof json.relay?.connectUrl === 'string' && (json.relay.connectUrl ?? '').includes('nodetime.cn'), json.relay?.connectUrl ?? '')
} catch (e) {
  check('B1 scheme https（浏览器/微信相机可打开）', false, String(e).slice(0, 60))
}

// —— C: 字符集 ——
check('C1 无空格/引号（URL 特殊字符不破坏扫码）', !/[\s"']/.test(link))
// web 端 QRCodeSVG 渲染同 payload——内容一致性由同 link 断言覆盖（A2 逐字节）；
// 尺寸/对比度核验：web 端 QRCodeSVG 默认 100% 宽容器、fg #000/bg #fff——代码审查记录于报告，不在本探针。

// 清理：吊销验证设备
try {
  const reg = JSON.parse((await import('node:fs')).readFileSync(`${homedir()}/.ecode/server.json`, 'utf8')) as { port: number; token: string }
  const list = (await (await fetch(`http://127.0.0.1:${reg.port}/api/devices`, { headers: { authorization: `Bearer ${reg.token}` } })).json()) as { devices: Array<{ deviceId: string; name: string }> }
  for (const d of list.devices) {
    if (d.name.startsWith('qr-verify-')) {
      await fetch(`http://127.0.0.1:${reg.port}/api/devices/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
        body: JSON.stringify({ deviceId: d.deviceId }),
      })
      console.log(`  [cleanup] 已吊销 ${d.name}`)
    }
  }
} catch { /* 清理失败不掩盖 */ }

const failed = results.filter((x) => !x.ok)
console.log(`\n# 结论：${results.length - failed.length}/${results.length} 过${failed.length > 0 ? '，失败：' + failed.map((f) => f.name).join(' / ') : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
