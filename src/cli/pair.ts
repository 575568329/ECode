/**
 * R1：`ecode pair` / `ecode devices` 命令面（M14 产品化线 R 方案 §5.2，D1 拍板：终端先行）。
 *
 * pair 流程：
 *   1. 生成设备条目（DeviceRegistry.create，192-bit per-device secret）；
 *   2. 打印 offer（URL + 机读文本）——手机 web 在配对页输入/扫码后以该 secret 作为 Bearer
 *      凭据访问 daemon（经隧道或局域网均可——relay 只转发字节不解析凭据）；
 *   3. daemon 侧凭据在**下一次启动**经 extraCredentials 注入（serve 启动读 devices.json）；
 *      运行中的 daemon 立即生效需重启（本形态披露，R2 控制信道后动态下发）。
 *
 * devices 命令面：list（表格）/ revoke <deviceId>（吊销即删——被吊销设备下一请求 401）。
 */

import { randomBytes } from 'node:crypto'
import { DeviceRegistry, devicesPath } from '../server/devices.js'

export interface PairResult {
  deviceId: string
  name: string
  secret: string
  scope: 'chat' | 'full'
}

/** 生成配对（命令面与测试共用） */
export function createPairing(name: string, scope: 'chat' | 'full' = 'chat', note?: string): PairResult {
  const registry = new DeviceRegistry()
  const entry = registry.create(name, scope, note)
  return { deviceId: entry.deviceId, name: entry.name, secret: entry.secret, scope: entry.scope }
}

/** offer 文本（打印给用户——手机 web 配对页消费 secret；QR 随 R5 补 qrcode-terminal） */
export function formatOffer(r: PairResult, webOrigin = ''): string {
  const base = webOrigin !== '' ? `${webOrigin.replace(/\/$/, '')}/` : '/'
  return [
    `✓ 设备已配对：${r.name}（${r.deviceId}）`,
    ``,
    `配对令牌（per-device，泄露可单独吊销）：`,
    `  ${r.secret}`,
    ``,
    `手机访问（浏览器打开后输入上述令牌）：`,
    `  ${base}ecode/`,
    ``,
    `权限：${r.scope === 'full' ? '全功能' : '对话+只读（chat）'}——吊销：ecode devices revoke ${r.deviceId}`,
  ].join('\n')
}

export function runPair(args: string[]): number {
  const name = args[0] ?? `设备-${randomBytes(2).toString('hex')}`
  const scope = args.includes('--full') ? ('full' as const) : ('chat' as const)
  const note = process.platform
  const r = createPairing(name, scope, note)
  process.stdout.write(`${formatOffer(r)}\n`)
  process.stdout.write(`\n注意：运行中的 daemon 需重启后才会认新设备凭据（ecode serve stop && ecode serve）。\n`)
  return 0
}

export function runDevices(args: string[]): number {
  const registry = new DeviceRegistry()
  if (args[0] === 'revoke') {
    const id = args[1]
    if (id === undefined) {
      process.stderr.write('用法：ecode devices revoke <deviceId>\n')
      return 1
    }
    const ok = registry.revoke(id)
    process.stdout.write(ok ? `✓ 已吊销 ${id}（下一请求即 401）\n` : `✗ 未找到设备 ${id}\n`)
    return ok ? 0 : 1
  }
  const list = registry.list()
  if (list.length === 0) {
    process.stdout.write(`尚无配对设备（ecode pair 配对）。注册表：${devicesPath()}\n`)
    return 0
  }
  process.stdout.write(`配对设备（${list.length}）：\n`)
  for (const d of list) {
    process.stdout.write(`  ${d.deviceId}  ${d.name}  [${d.scope}]  配对于 ${d.pairedAt}\n`)
  }
  return 0
}

void randomBytes
