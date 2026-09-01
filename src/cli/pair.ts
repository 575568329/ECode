/**
 * R1/R2：`ecode pair` / `ecode devices` 命令面（M14 产品化线 R 方案 §5.2，D1 拍板：终端先行）。
 * 核心逻辑下沉 src/server/pairing.ts（与 TUI /pair 命令共用）——本文件只剩 CLI 参数解析与打印。
 */

import { formatDevicesText, revokeDeviceText } from '../server/devices.js'
import { createPairingFull, formatPairingResult } from '../server/pairing.js'

export interface PairResult {
  deviceId: string
  name: string
  secret: string
  scope: 'chat' | 'full'
  /** 完整 offer（daemon 在跑时——relay 段/项目快照/钉公钥） */
  offer?: Record<string, unknown>
}

/** 生成配对（命令面与测试共用） */
export async function createPairing(name: string, scope: 'chat' | 'full' = 'chat', note?: string) {
  return createPairingFull(name, scope, note)
}

/** offer 文本（打印给用户——#pairing= 深链由手机 web 消费；QR 随行） */
export function formatOffer(r: Awaited<ReturnType<typeof createPairing>>, webOrigin = ''): string {
  void webOrigin // 兼容旧签名（webOrigin 已并入 offer 组装）
  return formatPairingResult(r)
}

export async function runPair(args: string[]): Promise<number> {
  const name = args.filter((a) => !a.startsWith('--'))[0] ?? ''
  const scope = args.includes('--full') ? ('full' as const) : ('chat' as const)
  const note = `${process.platform}`
  const r = await createPairing(name, scope, note)
  process.stdout.write(`${formatOffer(r)}
`)
  return 0
}

export async function runDevices(args: string[]): Promise<number> {
  if (args[0] === 'revoke') {
    const id = args[1]
    if (id === undefined) {
      process.stderr.write('用法：ecode devices revoke <deviceId>\n')
      return 1
    }
    process.stdout.write(`${await revokeDeviceText(id)}\n`)
    return 0
  }
  process.stdout.write(`${await formatDevicesText()}\n`)
  return 0
}
