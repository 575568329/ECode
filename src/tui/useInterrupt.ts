import { useEffect, useRef, useState } from 'react'
import { useInput } from 'ink'

const DEFAULT_WINDOW_MS = 1500

/**
 * Ctrl+C 双击退出（M2 §5.3）：
 *
 * - 第 1 次：调 onInterrupt（中断当前请求，如 abortController.abort()）+ 显示「再按一次退出」warning
 * - windowMs 内第 2 次：process.exit(0)
 * - 超过 windowMs：warning 自动清除，恢复单次中断语义
 * - 无请求进行时第 1 次：同样显示「再按一次退出」（onInterrupt 内自判是否真有请求）
 *
 * Ink render 时需传 exitOnCtrlC: false（第 6 步集成），否则 Ink 自己吞 Ctrl+C。
 */
export function useInterrupt(opts: {
  onInterrupt: () => void
  windowMs?: number
}): { warning: string | null } {
  const { onInterrupt, windowMs = DEFAULT_WINDOW_MS } = opts
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
      const now = Date.now()
      if (now - lastPressRef.current < windowMs) {
        process.exit(0)
      } else {
        lastPressRef.current = now
        setWarning('再按一次 Ctrl+C 退出')
        onInterrupt()
      }
    }
  })

  return { warning }
}
