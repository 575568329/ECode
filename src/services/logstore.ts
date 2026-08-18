/**
 * LogStore（AGENTS §2.7）：全系统唯一写入入口，JSONL 落盘。
 *
 * - 异步批量 flush（默认 100 条或 500ms），error 立即 flush
 * - close() **同步** flush（writeFileSync）：exit handler 是同步的，WriteStream async write
 *   不保证落盘 → 用 writeFileSync 兜住最后一批，崩溃/退出不丢关键日志
 * - payload 经 redact 脱敏（密钥不落日志）
 * - ≠ HistoryStore：LogStore 是运行 trace（调试，**不进 context**）；
 *   HistoryStore 是对话 messages（喂 LLM）。靠 sessionId 关联。
 */

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WriteStream } from 'node:fs'
import { redact } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory = 'loop' | 'provider' | 'tool' | 'config' | 'tui' | 'system' | 'skill' | 'mcp' | 'hooks' | 'plugin' | 'checkpoint' | 'quality'

export interface LogEntry {
  ts: string
  level: LogLevel
  category: LogCategory
  event: string
  sessionId: string
  iterNum?: number
  payload?: Record<string, unknown>
  /** M11：子代理轨迹隔离（grep agentId 即该代理全事件；主循环不带） */
  agentId?: string
}

export class LogStore {
  private buffer: LogEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly stream: WriteStream | null
  private closed = false
  private streamErrorNotified = false
  /** 已 flush 的行（仅 recordWritten=true 时记，供测试断言；生产 false 避免内存泄漏） */
  readonly written: string[] = []

  constructor(
    private readonly logPath: string,
    private readonly sessionId: string,
    private readonly maxBuffer = 100,
    private readonly flushMs = 500,
    private readonly recordWritten = false,
  ) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      this.stream = createWriteStream(logPath, { flags: 'a' })
      this.stream.on('error', (e) => {
        if (!this.streamErrorNotified) {
          process.stderr.write(`[LogStore] 日志落盘失败（后续不再提示）: ${e.message}\n`)
          this.streamErrorNotified = true
        }
      })
    } catch (e) {
      this.stream = null
      // 只读目录/无权限创建失败：日志不落盘但不崩，stderr 提示一次（D12 配套）
      process.stderr.write(
        `[LogStore] 日志目录创建失败（只读/无权限？），日志不落盘: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
  }

  emit(
    level: LogLevel,
    category: LogCategory,
    event: string,
    payload?: unknown,
    iterNum?: number,
    agentId?: string,
  ): void {
    if (this.closed) return
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      category,
      event,
      sessionId: this.sessionId,
      ...(iterNum !== undefined ? { iterNum } : {}),
      ...(agentId !== undefined && agentId !== '' ? { agentId } : {}),
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
    this.writeBuffer(this.stream ? this.stream.write.bind(this.stream) : null)
  }

  /** 关闭：同步 flush（exit handler 同步，用 writeFileSync 不丢最后一批） */
  close(): void {
    if (this.closed) return
    if (this.buffer.length > 0) {
      const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n'
      try {
        writeFileSync(this.logPath, lines, { flag: 'a' })
        if (this.recordWritten) {
          for (const e of this.buffer) this.written.push(JSON.stringify(e))
        }
      } catch {
        // 同步落盘失败只能吞（不能阻塞退出）
      }
      this.buffer = []
    }
    this.stream?.end()
    this.closed = true
  }

  private writeBuffer(write: ((s: string) => void) | null): void {
    if (this.recordWritten) {
      for (const e of this.buffer) this.written.push(JSON.stringify(e))
    }
    if (write) {
      const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n'
      write(lines)
    }
    this.buffer = []
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
