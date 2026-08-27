/**
 * 终端硬件光标管理（M14-C3① 自 cli/index.ts 拆出）。
 *
 * TUI 的输入位置由自绘反色 caret 呈现（TextInput §7.2），硬件光标
 * 在 Ink 掌屏期间纯属多余——裸留在帧尾闪烁。掌屏期常隐（Claude Code fork Ink 的
 * "hide cursor (Ink manages)" 同款），退出/恢复终端时还。
 *
 * conpty 注入防护（实测字节流实证）：conhost 会在进程启动/标题变化/子进程附着 console
 * 等时机向客户端流注入 OSC 标题 + ?25h 复位光标可见——本进程从未写过它，一次 ?25l
 * 与 write 拦截都挡不住。正解是逐写重隐：包一层 stdout.write，活跃期间每个写入块尾
 * 追加 ?25l（30fps 节流下每帧 6 字节，可忽略），任何来源的注入下一帧即被压回。
 */
import { writeSync } from 'node:fs'

/** DEC 私有模式：藏/还终端硬件光标（VT100 标准，conpty 支持） */
const CURSOR_HIDE = '\u001b[?25l'
const CURSOR_SHOW = '\u001b[?25h'

/** TUI 活跃期间为 true：stdout 写入守卫逐块尾追加 ?25l（见 hideTerminalCursor） */
let cursorGuardActive = false

export function hideTerminalCursor(): void {
  if (process.stdout.isTTY !== true) return
  cursorGuardActive = true
  process.stdout.write(CURSOR_HIDE)
  const stdout = process.stdout as typeof process.stdout & { __ecodeCursorGuard?: boolean }
  if (stdout.__ecodeCursorGuard !== true) {
    stdout.__ecodeCursorGuard = true
    const rawWrite = process.stdout.write.bind(process.stdout)
    const guardedWrite = (
      chunk: Uint8Array | string,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const ok =
        typeof encoding === 'function'
          ? rawWrite(chunk, encoding)
          : encoding !== undefined && cb !== undefined
            ? rawWrite(chunk, encoding, cb)
            : rawWrite(chunk)
      if (cursorGuardActive && chunk !== CURSOR_HIDE) rawWrite(CURSOR_HIDE)
      return ok
    }
    ;(process.stdout as unknown as { write: typeof guardedWrite }).write = guardedWrite
    // 空闲心跳：空闲态无帧写入，conpty 注入（子进程附着/标题变化）亮起的光标要等下一帧才会
    // 压回——500ms 心跳补上这个空窗。已隐藏时 conpty 按状态去重，客户端零流量，代价可忽略。
    const heartbeat = setInterval(() => {
      if (cursorGuardActive) rawWrite(CURSOR_HIDE)
    }, 500)
    heartbeat.unref?.()
  }
}

/** 停写守卫（卸载前调——Ink 收尾帧不再被追加 ?25l，随后可显式还光标） */
export function stopCursorGuard(): void {
  cursorGuardActive = false
}

export function showTerminalCursor(): void {
  if (process.stdout.isTTY !== true) return
  stopCursorGuard()
  try {
    writeSync(process.stdout.fd, CURSOR_SHOW)
  } catch {
    // fd 已关（崩溃收尾竞态）——尽力而为
  }
}
