import { describe, expect, it, vi } from 'vitest'
import { makeGracefulShutdown, SHUTDOWN_BUDGETS } from '../../src/services/gracefulShutdown.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeDeps(overrides: Partial<Parameters<typeof makeGracefulShutdown>[0]> = {}) {
  const order: string[] = []
  const deps = {
    restoreTerminal: () => { order.push('terminal') },
    runSessionEndHooks: async () => { order.push('hooks') },
    stopMcp: async () => { order.push('mcp') },
    exit: (code: number) => { order.push(`exit:${code}`) },
    ...overrides,
  }
  return { deps, order }
}

describe('makeGracefulShutdown', () => {
  it('顺序：终端恢复 → hooks → mcp → exit（全部完成路径）', async () => {
    const { deps, order } = makeDeps()
    const shutdown = makeGracefulShutdown(deps)
    shutdown(0)
    await sleep(30)
    expect(order).toEqual(['terminal', 'hooks', 'mcp', 'exit:0'])
  })

  it('hooks 挂死 → 预算截断后 mcp 与 exit 照常（不无限等）', async () => {
    const { deps, order } = makeDeps({
      runSessionEndHooks: () => new Promise(() => {}), // 永不 resolve
      budgets: { hooksMs: 30, mcpMs: 30, failsafeMs: 20 },
    })
    const shutdown = makeGracefulShutdown(deps)
    const t0 = Date.now()
    shutdown(0)
    await sleep(80)
    expect(order).toContain('mcp')
    expect(order).toContain('exit:0')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25) // 确实等了预算
  })

  it('hooks/mcp 抛错 → 清理链不断（fail-open 到 exit）', async () => {
    const { deps, order } = makeDeps({
      runSessionEndHooks: async () => { throw new Error('hook boom') },
      stopMcp: async () => { throw new Error('mcp boom') },
    })
    const shutdown = makeGracefulShutdown(deps)
    shutdown(1)
    await sleep(30)
    expect(order).toEqual(['terminal', 'exit:1'])
  })

  it('failsafe：全链挂死 → failsafe 定时器兜底 exit（注入定时器验证接线与公式）', async () => {
    const captured: { cb: () => void; ms: number }[] = []
    const { deps, order } = makeDeps({
      runSessionEndHooks: () => new Promise(() => {}), // 挂死：清理链永不走完
      stopMcp: () => new Promise(() => {}),
      setTimer: (cb, ms) => {
        captured.push({ cb, ms })
        setTimeout(cb, 20) // 模拟 failsafe 到期
        return { unref: () => {} }
      },
      budgets: { hooksMs: 5_000, mcpMs: 5_000, failsafeMs: 40 },
    })
    const shutdown = makeGracefulShutdown(deps)
    shutdown(0)
    await sleep(60)
    // 公式：max(failsafeMs, hooksMs+3500)——hooksMs 5000 时 8500（claude-code 同款 +3500 余量）
    expect(captured[0]?.ms).toBe(8_500)
    expect(order).toEqual(['terminal', 'exit:0']) // 清理链卡死，exit 来自 failsafe
  })

  it('重入守卫：第二次调用不重复执行清理链', async () => {
    const { deps, order } = makeDeps()
    const shutdown = makeGracefulShutdown(deps)
    shutdown(0)
    shutdown(0)
    await sleep(30)
    expect(order.filter((x) => x === 'terminal')).toHaveLength(1)
    expect(order.filter((x) => x.startsWith('exit'))).toHaveLength(1)
  })

  it('setTimer 注入：failsafe 定时器被 unref（不阻塞进程）', async () => {
    const unref = vi.fn()
    const { deps } = makeDeps({ setTimer: (_cb: () => void, _ms: number) => ({ unref }) })
    const shutdown = makeGracefulShutdown(deps)
    shutdown(0)
    expect(unref).toHaveBeenCalledTimes(1)
    await sleep(20)
  })

  it('默认预算常量合理（hooks/mcp 各 2s，failsafe 5s）', () => {
    expect(SHUTDOWN_BUDGETS.hooksMs).toBe(2_000)
    expect(SHUTDOWN_BUDGETS.mcpMs).toBe(2_000)
    expect(SHUTDOWN_BUDGETS.failsafeMs).toBe(5_000)
  })
})
