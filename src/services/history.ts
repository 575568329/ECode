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
import { isMessageLine, isBoundary, isRewind, type BoundaryLine, type HistoryLine, type Message, type RewindLine, type ImageBlock, type DocumentBlock, type ImageRefBlock } from '../core/types.js'
import { readFileSync } from 'node:fs'

export interface SessionMeta {
  sessionId: string
  createdAt: string
  model: string
  firstUser: string // 首条 user 消息摘要（/history 列表显示）
  /** M13-W4：会话所属项目路径（新会话落盘；存量无此字段归"未归类"——不回填） */
  cwd?: string
  /** M13-W4：活会话运行态（dispatch session/list 冷热合并时注入——不落盘） */
  running?: boolean
}

/** M12-P0：会话用量统计行（追加进会话 JSONL；自包含 cwd/model/ts——聚合不依赖 meta）。
 *  不属于 HistoryLine 联合——restoreFull 按 stats 标记跳过，永不进消息流（投影/翻译/rewind 零影响）。
 *  mcpCalls 是会话累计值（聚合取每会话最后一条）；漏尾说明：MCP 调用后必有下一轮 LLM 调用
 *  （工具结果回喂），usage 帧必到，纯 MCP 调用戛然而止的会话会低估。 */
export interface UsageStatsRecord {
  stats: true
  ts: number
  cwd: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costCny: number
  /** 审阅 P1-5：未收录定价的模型 costCny 记 0 且此标记 false——聚合侧提示"部分成本未知"而非静默低估 */
  costKnown: boolean
  mcpCalls: number
}

export interface HistoryStore {
  /** 增量追加一条 message（loop finally 已调，M1 占位兑现） */
  append(msg: Message): void
  /** 列所有会话 meta（读每个文件首行，按 createdAt 倒序） */
  loadAll(): SessionMeta[]
  /** 读某会话全部 messages（跳过 meta + boundary 行，纯 Message；M4 兼容） */
  restore(sessionId: string): Message[]
  /** 读某会话全量行（含 boundary，跳过 meta；M5 投影/UI/审计用） */
  restoreFull(sessionId: string): HistoryLine[]
  /** 压缩时追加 boundary 行（append-only，不删旧消息；投影锚点） */
  appendCompactBoundary(boundary: BoundaryLine): void
  /** /rewind 追加回退行（append-only；M9-P2 投影截断锚，重启恢复后仍生效） */
  appendRewind(line: RewindLine): void
  /** M12-P0：追加用量统计行（usage 帧驱动；聚合扫描用，不进消息流） */
  appendUsageStats(record: UsageStatsRecord): void
  /** 切换 sessionId（/history 恢复后续写新文件；旧文件只读不破坏，D2） */
  setSessionId(id: string, model?: string): void
  /** 恢复续写（D2 补全）：起新 id 并全量播种恢复行——fork 文件自包含，重开不丢前文 */
  forkSession(id: string, lines: HistoryLine[], model?: string): void
  /** 当前 sessionId（M9-P1：checkpoint 快照目录键控用；restore 后为新 id） */
  currentSessionId(): string
}

/** 首行 meta 标记（loadAll 只读首行，restore 过滤 meta 行） */
interface MetaLine extends SessionMeta {
  meta: true
}

export class FileHistoryStore implements HistoryStore {
  private readonly dir: string
  private model: string
  private sessionId: string
  private cwd?: string
  private createdAt: string
  private metaWritten = false
  private firstUser = '(空)'

  constructor(opts: { sessionId: string; model: string; cwd?: string; dir?: string }) {
    this.sessionId = opts.sessionId
    this.model = opts.model
    this.cwd = opts.cwd
    this.createdAt = new Date().toISOString()
    this.dir = opts.dir ?? path.join(os.homedir(), '.ecode', 'sessions')
    this.ensureDir()
  }

  private get filePath(): string {
    return path.join(this.dir, `${this.sessionId}.jsonl`)
  }

  private ensureDir(): void {
    try {
      // 0o700：会话文件有意不脱敏（P0-6），安全边界就是文件/目录权限——目录默认权限
      // 会让同机其他用户可列读（POSIX 生效；Windows 近似 no-op，不分平台直接设）
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
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
    // M10-P2b：落盘前 ImageBlock → ImageRef（base64 不进会话文件）
    this.appendStorable({ role: msg.role, content: msg.content.map(toStorableBlock) })
  }

  /** 实际写盘（storable 形态） */
  private appendStorable(msg: { role: Message['role']; content: StorableBlock[] }): void {
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
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
      }
      this.writeLine(JSON.stringify(meta))
      this.metaWritten = true
    }
    // 存原始 Message（不脱敏，P0-6）
    this.writeLine(JSON.stringify(msg))
  }

  /** 压缩时追加 boundary 行（append-only，旧消息不删；投影锚点） */
  appendCompactBoundary(boundary: BoundaryLine): void {
    this.writeLine(JSON.stringify(boundary))
  }

  /** M12-P0：用量统计行（append-only；读侧 restoreFull 按 stats 标记跳过） */
  appendUsageStats(record: UsageStatsRecord): void {
    this.writeLine(JSON.stringify(record))
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

  /** 当前 sessionId（M9-P1：checkpoint 快照目录键控） */
  currentSessionId(): string {
    return this.sessionId
  }

  /**
   * 恢复续写（D2 补全）：CC copyFileHistoryForResume 同款——旧文件只读，新文件全量播种。
   * 旧版只 setSessionId 不播种，fork 文件仅有恢复后的增量：跨一次重开即丢前文、
   * 恢复后不发言直接退出则 fork 文件根本不存在。正常轮次由 loop.ts 逐条增量 append，
   * 此处一次性播种不构成双写。
   */
  forkSession(id: string, lines: HistoryLine[], model?: string): void {
    this.setSessionId(id, model)
    for (const line of lines) {
      if (isBoundary(line)) this.appendCompactBoundary(line)
      else if (isRewind(line)) this.appendRewind(line)
      else if (isMessageLine(line)) this.append(line)
    }
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
            cwd: parsed.cwd,
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

  /** 读全量行（含 boundary，跳过 meta；M5 投影/UI/审计用） */
  restoreFull(sessionId: string): HistoryLine[] {
    const filePath = path.join(this.dir, `${sessionId}.jsonl`)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch (e) {
      // ENOENT（文件不存在=正常，首次/新 session）静默；其他错误（权限等）记录
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[HistoryStore] 读取会话失败 ${sessionId}：${e instanceof Error ? e.message : String(e)}\n`)
      }
      return []
    }
    const lines: HistoryLine[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { meta?: true; compact_boundary?: true; rewind?: true } & HistoryLine
        if (parsed.meta) continue // 跳过 meta 行
        if ((parsed as { stats?: true }).stats === true) continue // M12-P0：跳过用量统计行（不进消息流）
        // 终审 P2-1：按标记字段三分发——rewind 行伪装成 Message 是类型谎言（下游守卫兜得住，但新消费点会踩）
        if (parsed.compact_boundary) lines.push(parsed as BoundaryLine)
        else if (parsed.rewind) lines.push(parsed as RewindLine)
        else {
          // M10-P2b：存储态 image_ref → 内存态 ImageBlock（文件缺失降级 TextBlock 占位）
          const msg = parsed as Message
          const hasRef = msg.content.some(
            (b) =>
              (b as { type?: string }).type === 'image_ref' ||
              (b as { type?: string; blocks?: Array<{ type?: string }> }).blocks?.some((m) => m.type === 'image_ref') === true,
          )
          lines.push(hasRef ? { role: msg.role, content: msg.content.map((b) => fromStorableBlock(b)) } : msg)
        }
      } catch (e) {
        // 损坏行跳过但记录（不静默吞）
        process.stderr.write(`[HistoryStore] ${sessionId}.jsonl 跳过损坏行：${e instanceof Error ? e.message : String(e)}\n`)
      }
    }
    return lines
  }

  appendRewind(line: RewindLine): void {
    this.writeLine(JSON.stringify(line))
  }

  /** 读纯 Message（跳过 meta + boundary 行；M4 兼容） */
  restore(sessionId: string): Message[] {
    return this.restoreFull(sessionId).filter(isMessageLine)
  }
}

// —— M10-P2b：图片块的双向存储转换（内存 ImageBlock ↔ 落盘 ImageRef） ——

/** 落盘形态：ImageBlock → ImageRef（base64 换路径引用；其余块原样）。 */
/** 落盘形态（宽化：存储态可含 image_ref，内存态不含）。 */
type StorableBlock = Message['content'][number] | ImageRefBlock

function toStorableBlock(b: Message['content'][number]): StorableBlock {
  if (b.type === 'image') {
    // _path（read_file 源文件路径/粘贴附件路径）→ image_ref：base64 不进会话文件
    if (b._path !== undefined && b._path !== '') {
      return { type: 'image_ref', path: b._path, media_type: b.source.media_type }
    }
  }
  // 终审 P1-1：tool_result.blocks 附着块同样转换（read_file 主路径）
  if (b.type === 'tool_result' && b.blocks !== undefined && b.blocks.length > 0) {
    const storableBlocks = b.blocks.map((m) => (m.type === 'image' && m._path !== undefined && m._path !== ''
      ? ({ type: 'image_ref', path: m._path, media_type: m.source.media_type } as ImageRefBlock)
      : m))
    const anyRef = storableBlocks.some((m) => (m as { type?: string }).type === 'image_ref')
    if (anyRef) return { ...b, blocks: storableBlocks } as StorableBlock & { type: 'tool_result' }
  }
  return b
}

/** 恢复形态：ImageRef → ImageBlock（按路径重读 base64；失败降级 TextBlock 占位）。 */
function fromStorableBlock(b: unknown): Message['content'][number] {
  const ref = b as Partial<ImageRefBlock>
  // tool_result.blocks 内的 image_ref 递归恢复（终审 P1-1；复审 P2-6：降级文本并入 content
  // 字符串而非塞进 blocks——blocks 类型只允图片/文档，OpenAI 翻译器会静默丢弃 blocks 内 text）
  const maybeTR = b as { type?: string; blocks?: unknown[]; content?: string }
  if (maybeTR.type === 'tool_result' && Array.isArray(maybeTR.blocks)) {
    let degraded = ''
    const restoredBlocks: Array<ImageBlock | DocumentBlock> = []
    for (const m of maybeTR.blocks) {
      const r = fromStorableBlock(m)
      if ((r as { type?: string }).type === 'text') {
        degraded += `${degraded === '' ? '' : '\n'}${(r as { text: string }).text}`
      } else if ((r as { type?: string }).type === 'image' || (r as { type?: string }).type === 'document') {
        restoredBlocks.push(r as ImageBlock | DocumentBlock)
      }
    }
    const changed =
      degraded !== '' ||
      restoredBlocks.length !== maybeTR.blocks.length ||
      maybeTR.blocks.some((m) => (m as { type?: string }).type === 'image_ref') // 全部成功转换时数量也相等——须显式看是否有 ref 被换掉
    if (changed) {
      const base = { ...(b as object) } as Record<string, unknown>
      if (degraded !== '') base.content = `${maybeTR.content ?? ''}\n${degraded}`
      if (restoredBlocks.length > 0) base.blocks = restoredBlocks
      else delete base.blocks
      return base as unknown as Message['content'][number]
    }
    return b as Message['content'][number]
  }
  if (ref.type !== 'image_ref') return b as Message['content'][number]
  if (typeof ref.path !== 'string' || ref.path === '') {
    return { type: 'text', text: '[图片已失效（无路径）]' }
  }
  try {
    const buf = readFileSync(ref.path)
    const dims = ref.media_type === 'image/png' && buf.length >= 24 ? { _w: buf.readUInt32BE(16), _h: buf.readUInt32BE(20) } : {}
    const img: ImageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: ref.media_type ?? 'image/png', data: buf.toString('base64') },
      ...dims,
    }
    return img
  } catch {
    return { type: 'text', text: `[图片已失效 ${ref.path}]` }
  }
}

/** M1 stub（保留：未注入时兜底 / 测试隔离）。 */
export class NoopHistoryStore implements HistoryStore {
  append(_msg: Message): void {}
  appendCompactBoundary(_boundary: BoundaryLine): void {}
  appendRewind(_line: RewindLine): void {}
  appendUsageStats(_record: UsageStatsRecord): void {}
  loadAll(): SessionMeta[] {
    return []
  }
  restore(_sessionId: string): Message[] {
    return []
  }
  restoreFull(_sessionId: string): HistoryLine[] {
    return []
  }
  setSessionId(_id: string, _model?: string): void {}
  forkSession(_id: string, _lines: HistoryLine[], _model?: string): void {}
  currentSessionId(): string {
    return ''
  }
}


/**
 * M13-W4 历史反推项目发现：扫 sessions 目录首行 meta.cwd 去重聚合（/api/projects 第三源）。
 * 读侧兼容：存量文件无 cwd → 不出现（归"未归类"由调用方处理）；cwd 统一正斜杠返回。
 * 纯函数读文件系统，不动任何 store 实例（Web 项目列表零实例扫描——harness listVisible 同款语义）。
 */
export function collectProjectCwds(dir: string = path.join(os.homedir(), '.ecode', 'sessions')): string[] {
  const cwds = new Set<string>()
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  for (const f of files) {
    try {
      const buf = Buffer.alloc(2048)
      const fd = fs.openSync(path.join(dir, f), 'r')
      const bytes = fs.readSync(fd, buf, 0, 2048, 0)
      fs.closeSync(fd)
      const firstLine = buf.toString('utf8', 0, bytes).split('\n')[0]
      const parsed = JSON.parse(firstLine) as { meta?: true; cwd?: string }
      if (parsed.meta === true && parsed.cwd !== undefined && parsed.cwd !== '') {
        cwds.add(parsed.cwd.split(String.fromCharCode(92)).join('/'))
      }
    } catch {
      // 单文件损坏跳过（聚合是尽力而为）
    }
  }
  return [...cwds]
}
