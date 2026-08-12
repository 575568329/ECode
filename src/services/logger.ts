/**
 * Logger stub（M1）。
 *
 * M3/M4 替换为完整 LogStore（JSONL 结构化、异步批量 flush、轮转、集中脱敏），
 * 详设 §4.4。M1 只占接口位，emit 落 console.debug（不阻塞主循环）。
 * LogStore ≠ HistoryStore（详设 §4.4.5）：前者是运行 trace，不进 context。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEvent {
  level: LogLevel
  /** 'system' | 'loop' | 'provider' | 'tool' | 'tui' | 'error' */
  category: string
  event: string
  payload?: Record<string, unknown>
}

export interface Logger {
  emit(e: LogEvent): void
}

/** M1 stub：emit 落 console.debug（M3 替换为 LogStore.emit）。 */
export class ConsoleLogger implements Logger {
  emit(e: LogEvent): void {
    console.debug(`[${e.level}] ${e.category}/${e.event}`)
  }
}
