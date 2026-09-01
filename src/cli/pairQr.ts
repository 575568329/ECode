/**
 * R1/R5：配对 offer 的终端 QR（D1 拍板终端先行——qrcode-terminal 零传递依赖）。
 * CJS 无类型包经 createRequire 引入（免 @types 增项）；生成失败静默降级为无 QR
 * （链接文本始终在 offer 里——QR 是便捷面不是唯一面）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

interface QrcodeTerminal {
  generate: (text: string, opts?: { small?: boolean }) => void
}

let qrcode: QrcodeTerminal | null = null
try {
  qrcode = require('qrcode-terminal') as QrcodeTerminal
} catch {
  qrcode = null // 依赖缺失不阻断配对流程
}

/** 返回 QR 文本块（依赖缺失/生成失败返回空串——调用方直接拼接） */
export function formatOfferQr(text: string): string {
  if (qrcode === null) return ''
  const chunks: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  try {
    process.stdout.write = ((s: string) => {
      chunks.push(s)
      return true
    }) as typeof process.stdout.write
    qrcode.generate(text, { small: true })
  } catch {
    return ''
  } finally {
    process.stdout.write = write
  }
  return chunks.join('')
}
