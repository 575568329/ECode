import { useEffect, useState } from 'react'

/**
 * 共享动画时钟（M2 设计理念 §7.4：N 个 spinner 订阅一个 Clock）。
 *
 * - 单例 Clock：一个 setInterval 驱动所有订阅者，帧同步，避免多 spinner 各自 setInterval。
 * - 无订阅时自动停止（不空转）。
 * - 离屏暂停（useTerminalFocus）留后续优化；MVP 常驻跑。
 */

const TICK_MS = 80 // ~12.5fps，spinner 够流畅

type Listener = (frame: number) => void

class Clock {
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private frame = 0

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    this.ensureRunning()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private ensureRunning(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.frame += 1
      for (const fn of this.listeners) fn(this.frame)
    }, TICK_MS)
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

let singleton: Clock | null = null

function getClock(): Clock {
  if (singleton === null) singleton = new Clock()
  return singleton
}

/** 订阅共享时钟，返回当前帧号（每次 tick 重渲染） */
export function useClock(): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => getClock().subscribe(setFrame), [])
  return frame
}

/** 供测试：重置单例（避免测试间串扰） */
export function __resetClockForTest(): void {
  singleton = null
}
