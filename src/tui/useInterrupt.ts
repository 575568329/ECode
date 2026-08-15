import { useEffect, useRef, useState } from 'react'
import { useInput } from 'ink'

const DEFAULT_WINDOW_MS = 1500

/**
 * Ctrl+C 双击退出（M2 §5.3）：
 *
 * - 第 1 次：调 onInterrupt（中断当前请求，如 abortController.abort()）+ 显示「再按一次退出」warning
 * - windowMs 内第 2 次：onExit（默认 process.exit(0)；cli 注入优雅关闭——先恢复终端再
 *   预算内 await SessionEnd hooks / MCP stop，M7）
 * - 超过 windowMs：warning 自动清除，恢复单次中断语义
 * - 无请求进行时第 1 次：同样显示「再按一次退出」（onInterrupt 内自判是否真有请求）
 *
 * Ink render 时需传 exitOnCtrlC: false（第 6 步集成），否则 Ink 自己吞 Ctrl+C。
 */
export function useInterrupt(opts: {
  onInterrupt: () => void
  windowMs?: number
  /** 返回 true 时抑制 Ctrl+C（confirm 期间不 abort，由 ConfirmPrompt 独占，P0#1） */
  isActive?: () => boolean
  /** 双击退出的执行器（默认 process.exit(0)；cli 注入 gracefulShutdown） */
  onExit?: () => void
}): { warning: string | null } {
  const { onInterrupt, windowMs = DEFAULT_WINDOW_MS, isActive, onExit } = opts
  const lastPressRef = useRef(0)
  const [warning, setWarning] = useState<string | null>(null)

  // warning 超时清除
  useEffect(() => {
    if (warning === null) return
    const timer = setTimeout(() => setWarning(null), windowMs)
    return () => clearTimeout(timer)
  }, [warning, windowMs])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (isActive?.() === true) return // confirm 期间：让 ConfirmPrompt 独占 Ctrl+C
      const now = Date.now()
      if (now - lastPressRef.current < windowMs) {
        if (onExit !== undefined) onExit()
        else process.exit(0)
      } else {
        lastPressRef.current = now
        setWarning('再按一次 Ctrl+C 退出')
        onInterrupt()
      }
    }
  })

  return { warning }
}
