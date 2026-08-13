/**
 * HistoryStore 真实现（M4 P0-3）。
 *
 * 对话落盘 ~/.ecode/sessions/<sessionId>.jsonl（用户级，D12：防误删）。
 * 首行 meta（sessionId/createdAt/model/firstUser）+ 后续每行一条 Message。
 *
 * 同步写（appendFileSync）：对话频率低（每轮 1-2 条），同步写可靠——
 *   崩溃/退出不丢（无需 close flush），测试可直接读文件。
 *
 * P0-6：存原始 Message（不脱敏）——对话要原样恢复喂 LLM，
 *   脱敏会让 key 变 [REDACTED] 失效。靠文件权限 + 用户级目录保护。
 *   redact 只给 LogStore（trace）用，HistoryStore 存对话原文。
 *
 * setSessionId（P1-2）：/history 恢复后起新 session 续写（旧文件只读不破坏，D2）。
 *   LogStore 不跟切（sessionId readonly）——日志是启动期 trace，不跨会话关联。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Message } from '../core/types.js'

export interface SessionMeta {
  sessionId: string
  createdAt: string
  model: string
  firstUser: string // 首条 user 消息摘要（/history 列表显示）
}

export interface HistoryStore {
  /** 增量追加一条 message（loop finally 已调，M1 占位兑现） */
  append(msg: Message): void
  /** 列所有会话 meta（读每个文件首行，按 createdAt 倒序） */
  loadAll(): SessionMeta[]
  /** 读某会话全部 messages（跳过 meta 行） */
  restore(sessionId: string): Message[]
  /** 切换 sessionId（/history 恢复后续写新文件；旧文件只读不破坏，D2） */
  setSessionId(id: string, model?: string): void
}

/** 首行 meta 标记（loadAll 只读首行，restore 过滤 meta 行） */
interface MetaLine extends SessionMeta {
  meta: true
}

export class FileHistoryStore implements HistoryStore {
  private readonly dir: string
  private model: string
  private sessionId: string
  private createdAt: string
  private metaWritten = false
  private firstUser = '(空)'

  constructor(opts: { sessionId: string; model: string; dir?: string }) {
    this.sessionId = opts.sessionId
    this.model = opts.model
    this.createdAt = new Date().toISOString()
    this.dir = opts.dir ?? path.join(os.homedir(), '.ecode', 'sessions')
    this.ensureDir()
  }

  private get filePath(): string {
    return path.join(this.dir, `${this.sessionId}.jsonl`)
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (e) {
      process.stderr.write(
        `[HistoryStore] sessions 目录创建失败（只读/无权限？）: ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
  }

  /** 同步写一行（崩溃不丢；落盘失败 stderr 提示但不崩） */
  private writeLine(line: string): void {
    try {
      fs.appendFileSync(this.filePath, line + '\n')
    } catch (e) {
      process.stderr.write(`[HistoryStore] 对话落盘失败: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  append(msg: Message): void {
    // 懒写首行 meta：首条 message append 时写（首条通常是 user，firstUser 此刻已知）
    if (!this.metaWritten) {
      if (msg.role === 'user') {
        const text = msg.content.find((b) => b.type === 'text') as { text?: string } | undefined
        this.firstUser = text?.text?.slice(0, 80)?.trim() || '(无文本)'
      }
      const meta: MetaLine = {
        meta: true,
        sessionId: this.sessionId,
        createdAt: this.createdAt,
        model: this.model,
        firstUser: this.firstUser,
      }
      this.writeLine(JSON.stringify(meta))
      this.metaWritten = true
    }
    // 存原始 Message（不脱敏，P0-6）
    this.writeLine(JSON.stringify(msg))
  }

  /** 切换 sessionId（/history 恢复后续写新文件；旧文件只读不破坏，D2） */
  setSessionId(id: string, model?: string): void {
    if (id === this.sessionId) return
    this.sessionId = id
    if (model) this.model = model
    this.createdAt = new Date().toISOString()
    this.metaWritten = false
    this.firstUser = '(空)'
    this.ensureDir()
  }

  /** 只读文件首行（P1-13：loadAll 避免全量读大 session 文件，读前 2048 字节取首行足够 meta） */
  private readFirstLine(filePath: string): string {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(2048)
      const n = fs.readSync(fd, buf, 0, 2048, 0)
      return buf.toString('utf8', 0, n).split('\n')[0]
    } finally {
      fs.closeSync(fd)
    }
  }

  loadAll(): SessionMeta[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const f of files) {
      try {
        const firstLine = this.readFirstLine(path.join(this.dir, f))
        if (!firstLine.trim()) continue
        const parsed = JSON.parse(firstLine) as MetaLine
        if (parsed.meta) {
          metas.push({
            sessionId: parsed.sessionId,
            createdAt: parsed.createdAt,
            model: parsed.model,
            firstUser: parsed.firstUser,
          })
        }
      } catch (e) {
        // P2-2：损坏文件跳过但记录（不静默吞）
        process.stderr.write(`[HistoryStore] 跳过损坏会话文件 ${f}：${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
    // 按 createdAt 倒序（最新在前）
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  restore(sessionId: string): Message[] {
    const filePath = path.join(this.dir, `${sessionId}.jsonl`)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch (e) {
      // P2-2：ENOENT（文件不存在=正常，首次/新 session）静默；其他错误（权限等）记录
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[HistoryStore] 读取会话失败 ${sessionId}：${e instanceof Error ? e.message : String(e)}\n`)
      }
      return []
    }
    const messages: Message[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { meta?: true } & Message
        if (parsed.meta) continue // 跳过 meta 行
        messages.push(parsed as Message)
      } catch (e) {
        // P2-2：损坏行跳过但记录（不静默吞）
        process.stderr.write(`[HistoryStore] ${sessionId}.jsonl 跳过损坏行：${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
    return messages
  }
}

/** M1 stub（保留：未注入时兜底 / 测试隔离）。 */
export class NoopHistoryStore implements HistoryStore {
  append(_msg: Message): void {}
  loadAll(): SessionMeta[] {
    return []
  }
  restore(_sessionId: string): Message[] {
    return []
  }
  setSessionId(_id: string, _model?: string): void {}
}
