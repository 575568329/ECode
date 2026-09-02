/**
 * M14-C2⑦：SSE 写出与慢消费者守卫（审阅 P1-6——三处 write false 只挂空 drain
 * 回调的 no-op 背压，注释宣称与实现相反）。
 *
 * 策略：write 返回 false 即视为背压开始，起 SLOW_MS 计时；drain 到来或后续
 * write true（缓冲排空到内核）即恢复。计时器触发=持续 SLOW_MS 无消费的慢
 * 消费者——销毁连接止损，防缓冲无界（SSE 无应用层重试语义，断开由客户端
 * 重连兜底；比"无限缓冲"或"静默丢帧"都正确）。
 */

/** 慢消费者判定窗口：连续无消费时长 */
export const SLOW_CONSUMER_MS = 5_000

type SseWritable = { write(chunk: string): boolean; once(ev: 'drain', fn: () => void): void; destroy(): void; writableEnded?: boolean; destroyed?: boolean }

/**
 * 创建受守卫的 SSE 写函数。ping 注释帧同样经此路径（心跳写阻塞同样算背压）。
 * 返回的 write 不回传背压状态（调用方无需分支——守卫自治）。
 */
export function guardedSseWrite(res: SseWritable): (chunk: string) => void {
  let slowTimer: ReturnType<typeof setTimeout> | null = null
  let drainArmed = false
  const clearSlow = (): void => {
    if (slowTimer !== null) {
      clearTimeout(slowTimer)
      slowTimer = null
    }
  }
  const onDrain = (): void => {
    drainArmed = false
    clearSlow()
  }
  return (chunk: string): void => {
    // 审阅修复（架构席 P1-3 双保险）：连接销毁后短路——迟到的订阅回调再 write 只会
    // 静默丢+反复起 5s slowTimer（OutgoingMessage 销毁态 write 不抛）
    if (res.writableEnded === true || res.destroyed === true) return
    if (res.write(chunk) === false) {
      clearSlow()
      slowTimer = setTimeout(() => res.destroy(), SLOW_CONSUMER_MS)
      slowTimer.unref?.()
      if (!drainArmed) {
        drainArmed = true
        res.once('drain', onDrain)
      }
    } else {
      clearSlow()
    }
  }
}
