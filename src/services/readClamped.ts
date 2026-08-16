/**
 * 上限读取公共实现（审阅 P1-6/P1-9 收敛——instructions 与 memory 原各持一份，
 * 第二份手写时走样出死分支与字符/字节混淆）。
 *
 * stat 先行：小文件全读；超上限只定位读上限字节（超大误写文件不整读进内存）。
 * open/read 全程异常防护（Windows AV 独占锁 EBUSY 等——注入加载失败不阻塞启动，
 * 调用方 catch 后静默跳过）。返回截断信号，尾注文案由调用方拼（各级提示不同）。
 */

import * as fs from 'node:fs'

export interface ClampedRead {
  text: string
  /** stat.size > maxBytes（截断判定用总大小语义，非读出文本长度） */
  truncated: boolean
}

export function readClampedFile(file: string, maxBytes: number): ClampedRead | undefined {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return undefined
  }
  if (size <= maxBytes) {
    try {
      return { text: fs.readFileSync(file, 'utf8'), truncated: false }
    } catch {
      return undefined
    }
  }
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const read = fs.readSync(fd, buf, 0, maxBytes, 0)
      return { text: buf.subarray(0, read).toString('utf8'), truncated: true }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}
