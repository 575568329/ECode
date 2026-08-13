/**
 * LogStore（AGENTS §2.7）：全系统唯一写入入口，JSONL 落盘。
 *
 * - 异步批量 flush（默认 100 条或 500ms），error 立即 flush
 * - close() 同步 flush（exit 前调，崩溃不丢关键日志）
 * - payload 经 redact 脱敏（密钥不落日志）
 * - ≠ HistoryStore：LogStore 是运行 trace（调试用，**不进 context**）；
 *   HistoryStore 是对话 messages（喂 LLM、/history 恢复）。靠 sessionId 关联。
 */

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WriteStream } from 'node:fs'
import { redact } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory = 'loop' | 'provider' | 'tool' | 'config' | 'tui' | 'system'

export interface LogEntry {
  ts: string
  level: LogLevel
  category: LogCategory
  event: string
  sessionId: string
  iterNum?: number
  payload?: Record<string, unknown>
}

export class LogStore {
  private buffer: LogEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly stream: WriteStream | null
  private closed = false
  /** 已 flush 的行（测试断言用；生产从文件读） */
  readonly written: string[] = []

  constructor(
    logPath: string,
    private readonly sessionId: string,
    private readonly maxBuffer = 100,
    private readonly flushMs = 500,
  ) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      this.stream = createWriteStream(logPath, { flags: 'a' })
      // 落盘失败不阻塞主流程（只丢日志）
      this.stream.on('error', () => {})
    } catch {
      this.stream = null
    }
  }

  emit(
    level: LogLevel,
    category: LogCategory,
    event: string,
    payload?: unknown,
    iterNum?: number,
  ): void {
    if (this.closed) return
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      category,
      event,
      sessionId: this.sessionId,
      ...(iterNum !== undefined ? { iterNum } : {}),
      ...(payload !== undefined ? { payload: redact(payload) as Record<string, unknown> } : {}),
    }
    this.buffer.push(entry)
    if (level === 'error' || this.buffer.length >= this.maxBuffer) {
      this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.flushMs)
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n'
    for (const e of this.buffer) this.written.push(JSON.stringify(e))
    if (this.stream) this.stream.write(lines)
    this.buffer = []
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  close(): void {
    if (this.closed) return
    this.flush()
    this.stream?.end()
    this.closed = true
  }
}
