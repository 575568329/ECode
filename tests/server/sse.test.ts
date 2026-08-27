import { describe, expect, it, vi } from 'vitest'
import { guardedSseWrite, SLOW_CONSUMER_MS } from '../../src/server/sse.js'

/** 假 SSE response：write 返回值可编程控制，drain 监听可手动触发 */
function mkRes(writeReturns: () => boolean) {
  const state = { destroyed: false, drainFns: [] as Array<() => void>, writes: [] as string[] }
  const res = {
    write(chunk: string): boolean {
      state.writes.push(chunk)
      return writeReturns()
    },
    once(_ev: 'drain', fn: () => void): void {
      state.drainFns.push(fn)
    },
    destroy(): void {
      state.destroyed = true
    },
  }
  return { res, state, fireDrain: () => { const fns = state.drainFns.splice(0); fns.forEach((fn) => fn()) } }
}

describe('guardedSseWrite（M14-C2⑦ 慢消费者守卫）', () => {
  it('write true：正常写出不销毁', () => {
    const { res, state } = mkRes(() => true)
    const write = guardedSseWrite(res)
    write('data: x\n\n')
    expect(state.writes).toEqual(['data: x\n\n'])
    expect(state.destroyed).toBe(false)
  })

  it('write false → drain 恢复：不销毁', () => {
    const { res, state, fireDrain } = mkRes(() => false)
    const write = guardedSseWrite(res)
    write('data: x\n\n')
    fireDrain()
    expect(state.destroyed).toBe(false)
  })

  it('write false 持续无 drain 超时：销毁连接', () => {
    vi.useFakeTimers()
    try {
      const { res, state } = mkRes(() => false)
      const write = guardedSseWrite(res)
      write('data: x\n\n')
      expect(state.destroyed).toBe(false)
      vi.advanceTimersByTime(SLOW_CONSUMER_MS + 1)
      expect(state.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('背压后恢复写出（write true）清除挂起计时', () => {
    vi.useFakeTimers()
    try {
      let blocked = true
      const { res, state } = mkRes(() => !blocked)
      const write = guardedSseWrite(res)
      blocked = true
      write('a') // false → 计时挂起
      blocked = false
      write('b') // true → 恢复，计时清除
      vi.advanceTimersByTime(SLOW_CONSUMER_MS + 1)
      expect(state.destroyed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
