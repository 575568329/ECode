/**
 * 优雅关闭工厂（M7 审阅后补：SessionEnd hook 的可靠执行路径）。
 *
 * 模式（claude-code 同款"关闭窗口 + failsafe 双保险"）：hook 不在 process.on('exit') 里跑
 * （exit 内不能 await，事件循环将停），而在信号 handler / 双击退出 / argv 收尾发起的
 * async 关闭函数里 await——信号 handler 内事件循环仍存活。
 *
 * 顺序铁律：① 先同步恢复终端（Ink unmount 清 raw mode）——后续被强杀也不留烂终端；
 * ② SessionEnd hooks 预算内 await；③ MCP 优雅关预算内 await；④ exit（exit handler
 * 接管 stopNow 兜底 + 日志 flush）。failsafe 定时器 = max(5000, hooksMs+3500)，unref
 * 不占事件循环——清理挂死也保证退出。
 */

export interface GracefulShutdownBudgets {
  /** SessionEnd hooks 预算（退出期 hook 需比普通 hook 紧得多的界） */
  hooksMs: number
  /** MCP 优雅关预算 */
  mcpMs: number
  /** failsafe 强退下限（实际取 max(failsafeMs, hooksMs+3500)） */
  failsafeMs: number
}

export const SHUTDOWN_BUDGETS: GracefulShutdownBudgets = {
  hooksMs: 2_000,
  mcpMs: 2_000,
  failsafeMs: 5_000,
}

export interface GracefulShutdownDeps {
  /** 同步恢复终端（Ink unmount；必须最先执行） */
  restoreTerminal?: () => void
  /** SessionEnd hooks 分发（预算内 await；throw 视为完成——fail-open） */
  runSessionEndHooks: () => Promise<unknown>
  /** MCP 优雅关（预算内 await；throw 视为完成） */
  stopMcp: () => Promise<unknown>
  /** M10-P3：后台任务全杀（预算内 await；throw 视为完成——killTree 自带梯度） */
  stopTasks?: () => Promise<unknown>
  /** 退出（默认 process.exit；测试注入） */
  exit?: (code: number) => void
  /** 定时器工厂（测试注入；默认 setTimeout 且 unref） */
  setTimer?: (cb: () => void, ms: number) => { unref(): void }
  budgets?: Partial<GracefulShutdownBudgets>
}

/** 预算内等待：完成/失败/超时三者任一即续（失败不抛——清理链不断）。 */
function raceSettled(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    void (p ?? Promise.resolve()).then(finish, finish)
  })
}

export function makeGracefulShutdown(deps: GracefulShutdownDeps): (code: number) => void {
  const b: GracefulShutdownBudgets = { ...SHUTDOWN_BUDGETS, ...deps.budgets }
  const setTimer =
    deps.setTimer ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as { unref(): void })
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let shuttingDown = false

  return (code: number): void => {
    if (shuttingDown) return // 双信号重入：等 failsafe
    shuttingDown = true

    // failsafe：清理链挂死也保证退出
    setTimer(() => exit(code), Math.max(b.failsafeMs, b.hooksMs + 3_500)).unref()

    void (async () => {
      deps.restoreTerminal?.() // 同步先行（后续被强杀终端已恢复）
      await raceSettled(deps.runSessionEndHooks(), b.hooksMs)
      await raceSettled(deps.stopMcp(), b.mcpMs)
      await raceSettled(deps.stopTasks?.(), b.mcpMs) // 复用 MCP 预算档（同类清理）
      exit(code)
    })()
  }
}
