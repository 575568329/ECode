/**
 * ask_user UI 桥（M8 §2，M8-D3）：工具层 ↔ TUI 层的解耦通道。
 *
 * 工具是静态对象（SkillTool 同款），TUI overlay 在 TuiApp——经模块级桥注入
 * （TuiApp 挂载时 set，卸载清空）。argv 单次模式/未挂载 → isInteractive=false，
 * 工具返回非交互提示（模型自行决策，不挂死——M8-D5）。
 * 会话级排队锁（M8-D4）：readonly 工具会被 executeTools 与其它只读工具并行，
 * 同轮多个 ask_user 抢 overlay——先到先弹，后到 await 排队。
 */

import type { AskUserQuestion, AskUserResult } from './ask_user.js'

export type AskUserHandler = (questions: AskUserQuestion[]) => Promise<AskUserResult>

let handler: AskUserHandler | null = null
let queue: Promise<unknown> = Promise.resolve()

/** TuiApp 挂载时注入（卸载传 null 清空）。 */
export function setAskUserHandler(h: AskUserHandler | null): void {
  handler = h
}

/** 是否有 UI 可用（argv/管道模式 false）。 */
export function askUserInteractive(): boolean {
  return handler !== null
}

/**
 * 工具入口：排队（串行化 overlay）后调 handler。
 * 队列异常不阻塞后续（finally 链接）。
 */
export function askUserViaUI(questions: AskUserQuestion[]): Promise<AskUserResult> {
  if (handler === null) {
    return Promise.resolve({ kind: 'non-interactive' })
  }
  const run = queue.then(() => (handler as AskUserHandler)(questions))
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
