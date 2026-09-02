/**
 * 流停滞看门狗（P0-B，方案 docs/详设/2026-09-02_后续-真机诊断修复方案 §2）。
 *
 * 背景：LLM 请求此前无任何超时机制——连接黑 hole / 端点长时间不吐字时永远挂着
 * （真机实证单次 188s 仅回 80 token）；且静默流场景 loop 的逐 chunk 检查没有执行
 * 机会，signal 传参修复（批1a）之外还需看门狗兜底「死流」。
 *
 * 语义：流内连续 stallMs 零**内容性** delta（text/thinking/tool_use_delta——协议层
 * 心跳/空帧不算，防假喂狗）→ abort 组合 signal。重试与转译决策在 provider 侧
 * （openai.ts / anthropic.ts）：仅零产出首次停滞重试 1 次；仍停滞或有产出 → 显式
 * STREAM_STALL error delta（不能只 abort：openai v7 SDK 吞 AbortError 静默收尾、
 * anthropic SDK 转 APIUserAbortError 被误判用户中断——loop 都无从走重试/报错路径）。
 *
 * 建流前即武装（连接黑 hole/首 token 不来同受管）；stallMs=0 完全旁路（signal 原样透传）。
 */

/** 缺省 90s：足够长思考的首 token 间隔通常 <30s；非流式 thinking 端点可配置调大 */
export const DEFAULT_STREAM_STALL_MS = 90_000

/** 用户中断判定。独立函数而非内联 `req.signal?.aborted`：TS 控制流分析会把循环顶部判过的
 *  .aborted 窄化成 false——但 abort 是异步事件（流期间用户 Ctrl+C），运行时会变，函数调用隔断窄化 */
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export interface StallWatchdog {
  /** 传给 SDK 的组合 signal（用户 signal ∪ 停滞 signal）；无信号源时 undefined */
  readonly signal: AbortSignal | undefined
  /** 喂狗：每个内容性 delta 到达时调用（重置计时） */
  feed(): void
  /** 看门狗是否已触发（流静默收尾时以此区分「停滞」与「正常结束」） */
  fired(): boolean
  /** 清理计时器（run 的 finally 必调；anthropic.ts 摘 listener 是同款先例） */
  dispose(): void
}

export function createStallWatchdog(userSignal: AbortSignal | undefined, stallMs: number): StallWatchdog {
  if (stallMs <= 0) {
    return { signal: userSignal, feed: () => {}, fired: () => false, dispose: () => {} }
  }
  const stall = new AbortController()
  const signal = userSignal !== undefined ? AbortSignal.any([userSignal, stall.signal]) : stall.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let firedFlag = false
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      firedFlag = true
      stall.abort()
    }, stallMs)
  }
  arm() // 建流前即武装（连接黑 hole/首 token 不来同受管）
  return { signal, feed: arm, fired: () => firedFlag, dispose: () => clearTimeout(timer) }
}
