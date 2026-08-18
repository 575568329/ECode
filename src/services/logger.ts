/**
 * Logger（AGENTS §2.7）：全系统唯一写入入口经 LogStore 落 JSONL。
 *
 * LogStore ≠ HistoryStore：Logger 是运行 trace（调试用，**不进 context**）；
 * HistoryStore 是对话 messages（喂 LLM）。payload 在 LogStore 内经 redact 脱敏。
 */

import type { LogStore, LogCategory } from './logstore.js'

export interface Logger {
  debug(category: LogCategory, event: string, payload?: unknown, iterNum?: number, agentId?: string): void
  info(category: LogCategory, event: string, payload?: unknown, iterNum?: number, agentId?: string): void
  warn(category: LogCategory, event: string, payload?: unknown, iterNum?: number, agentId?: string): void
  error(category: LogCategory, event: string, payload?: unknown, iterNum?: number, agentId?: string): void
}

/** JsonlLogger：所有日志经 LogStore 落 JSONL（异步批量 + 脱敏 + error 立即 flush）。 */
export class JsonlLogger implements Logger {
  constructor(private readonly store: LogStore) {}
  debug(c: LogCategory, e: string, p?: unknown, i?: number, agentId?: string) {
    this.store.emit('debug', c, e, p, i, agentId)
  }
  info(c: LogCategory, e: string, p?: unknown, i?: number, agentId?: string) {
    this.store.emit('info', c, e, p, i, agentId)
  }
  warn(c: LogCategory, e: string, p?: unknown, i?: number, agentId?: string) {
    this.store.emit('warn', c, e, p, i, agentId)
  }
  error(c: LogCategory, e: string, p?: unknown, i?: number, agentId?: string) {
    this.store.emit('error', c, e, p, i, agentId)
  }
}
