/**
 * CheckpointStore：Agent 改文件前的快照与还原（M9-P1 / M9-D14）。
 *
 * 布局（content-addressed）：~/.ecode/checkpoints/<sessionId>/
 *   objects/<sha256>   对象库——按文件内容寻址，同内容多轮未变只存一份
 *   <seq>/meta.json    快照点——时间/工具/消息 id/文件清单（原路径 → hash 引用）
 *
 * 治理：每会话 MAX_PER_SESSION 点（淘汰最旧——删 seq 目录后重扫引用集回收孤儿 objects，
 * 多点共享对象不可直接删）；全局 MAX_SESSIONS 会话目录（mtime 淘汰最旧）；
 * 单文件 >MAX_FILE_BYTES 跳过 + warn；bash 快照 = cwd 下 git status 近修改集（无 git 跳过 + warn）。
 *
 * 还原语义（M9-D14）：选中点自身及其之后逆序还原 = 回到该点执行前（每文件取范围内最早基线）；
 * 还原前自动快照当前状态（撤销可撤销）；外部改动文件单独报告，由调用方确认——不静默覆盖。
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MAX_PER_SESSION = 100
export const MAX_SESSIONS = 50
export const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface CheckpointFileRef {
  /** 绝对路径（正斜杠规范化由调用方保证；此处原样存储） */
  path: string
  hash: string
}

export interface CheckpointMeta {
  seq: number
  time: string
  tool: string
  messageId?: string
  files: CheckpointFileRef[]
}

export interface RevertResult {
  /** 实际写回的文件（绝对路径） */
  restored: string[]
  /** 还原前检测到快照后有外部修改的文件（当前内容 ≠ 最近快照基线；调用方确认页标注） */
  externalChanged: string[]
}

export interface CheckpointOpts {
  rootDir?: string
  maxPerSession?: number
  maxSessions?: number
  maxFileBytes?: number
  warn?: (msg: string) => void
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export class CheckpointStore {
  /** M11-P1：操作串行链——并发 snapshot（多子代理同时写前快照）下 nextSeq 读改写竞态会产生重复 seq */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly root: string
  private readonly cwd: string
  private readonly maxPerSession: number
  private readonly maxSessions: number
  private readonly maxFileBytes: number
  private readonly warn: (msg: string) => void

  constructor(cwd: string, opts?: CheckpointOpts) {
    this.cwd = cwd
    this.root = opts?.rootDir ?? join(homedir(), '.ecode', 'checkpoints')
    this.maxPerSession = opts?.maxPerSession ?? MAX_PER_SESSION
    this.maxSessions = opts?.maxSessions ?? MAX_SESSIONS
    this.maxFileBytes = opts?.maxFileBytes ?? MAX_FILE_BYTES
    this.warn = opts?.warn ?? (() => {})
  }

  private sessionDir(sessionId: string): string {
    return join(this.root, sessionId)
  }

  /**
   * 快照一批文件的写前基线（确认已通过的副作用工具 execute 开头调用）。
   * paths 为空 = 近修改集兜底（bash 场景：git status 变更文件；无 git 跳过 + warn）。
   * 读不到（文件将新建，无基线）/ 超限跳过的文件不入本点；全空返回 null。
   */
  async snapshot(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<number | null> {
    // 审阅 P1-4：治理与快照同一链内排队——enforceLimits 在链外会与下一个并发快照交叠
    //（B 的对象已写而 meta 未落时 GC 判孤儿删除 → 悬空快照）。失败不阻塞后续（finally 链接）。
    const run = this.chain.then(
      () => this.snapshotAndLimit(sessionId, paths, meta),
      () => this.snapshotAndLimit(sessionId, paths, meta),
    )
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async snapshotAndLimit(
    sessionId: string,
    paths: string[],
    meta: { tool: string; messageId?: string },
  ): Promise<number | null> {
    const seq = await this.snapshotCoreRun(sessionId, paths, meta)
    if (seq !== null) await this.enforceLimits(sessionId)
    return seq
  }

  /**
   * snapshot 主体（不含治理）。revert 的还原前自动快照必须走这里：治理会淘汰最旧点并
   * GC 其独占对象，而那可能正是本次 revert 即将写回的基线（终审 P1-3 竞态——还原不完整）。
   * 跳过的治理无害：点数暂时 +1，下次正常快照照常收口。
   */
  private snapshotCore(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<number | null> {
    // 串行链排队：并发调用逐个执行（nextSeq/对象写入互斥）；失败不阻塞后续（finally 链接）
    const run = this.chain.then(
      () => this.snapshotCoreRun(sessionId, paths, meta),
      () => this.snapshotCoreRun(sessionId, paths, meta),
    )
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async snapshotCoreRun(sessionId: string, paths: string[], meta: { tool: string; messageId?: string }): Promise<number | null> {
    const files = paths.length > 0 ? paths : await this.gitDirtyFiles()
    if (files.length === 0) return null
    const refs: CheckpointFileRef[] = []
    for (const p of files) {
      try {
        const st = await stat(p)
        if (st.size > this.maxFileBytes) {
          this.warn(`快照跳过（超过 ${Math.round(this.maxFileBytes / 1024 / 1024)}MB）：${p}`)
          continue
        }
        const buf = await readFile(p)
        const hash = sha256(buf)
        const objFile = join(this.sessionDir(sessionId), 'objects', hash)
        if (!(await exists(objFile))) {
          await mkdir(dirname(objFile), { recursive: true })
          await writeFile(objFile, buf)
        }
        refs.push({ path: p, hash })
      } catch {
        // 文件不存在（新建）等读失败：无基线可拍，跳过该文件
      }
    }
    if (refs.length === 0) return null
    const seq = (await this.nextSeq(sessionId))
    const m: CheckpointMeta = { seq, time: new Date().toISOString(), tool: meta.tool, messageId: meta.messageId, files: refs }
    await mkdir(join(this.sessionDir(sessionId), String(seq)), { recursive: true })
    await writeFile(join(this.sessionDir(sessionId), String(seq), 'meta.json'), JSON.stringify(m, null, 2), 'utf8')
    return seq
  }

  /** 列出会话全部快照点（seq 升序；损坏的 meta 跳过）。 */
  async list(sessionId: string): Promise<CheckpointMeta[]> {
    const dir = this.sessionDir(sessionId)
    if (!(await exists(dir))) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const seqs = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name)).sort((a, b) => a - b)
    const metas: CheckpointMeta[] = []
    for (const seq of seqs) {
      try {
        const raw = await readFile(join(dir, String(seq), 'meta.json'), 'utf8')
        metas.push(JSON.parse(raw) as CheckpointMeta)
      } catch {
        // 损坏点跳过（不阻断列表）
      }
    }
    return metas
  }

  /**
   * 外部改动检测：还原范围内每个文件，当前内容 hash ≠ 其最近一次快照基线 → 报告
   * （CC checkOriginFileChanged 同款语义：快照后被用户手动改过，还原将覆盖——由用户决定）。
   */
  async detectExternalChanges(sessionId: string, seq: number): Promise<string[]> {
    const metas = (await this.list(sessionId)).filter((m) => m.seq >= seq)
    const latest = new Map<string, string>()
    for (const m of metas) for (const f of m.files) latest.set(f.path, f.hash)
    const changed: string[] = []
    for (const [p, base] of latest) {
      try {
        if (sha256(await readFile(p)) !== base) changed.push(p)
      } catch {
        // 文件已被删除：还原会重建，不算外部修改
      }
    }
    return changed
  }

  /**
   * 还原：选中点（含）及之后全部快照逆序写回 = 回到该点执行前。
   * 还原前先对涉及文件拍 rewind-auto 点（撤销可撤销）。外部改动只报告不拦截（调用方确认页用）。
   */
  async revert(sessionId: string, seq: number): Promise<RevertResult> {
    const metas = (await this.list(sessionId)).filter((m) => m.seq >= seq)
    if (metas.length === 0) throw new Error(`快照点 ${seq} 不存在`)
    const externalChanged = await this.detectExternalChanges(sessionId, seq)
    const fileSet = new Set<string>()
    for (const m of metas) for (const f of m.files) fileSet.add(f.path)
    // 还原前自动快照当前状态（含外部改动后的现状——回错了可再 revert 回来）。
    // 走 snapshotCore：此时治理会淘汰最旧点/GC 对象，可能删掉本次正要写回的基线（终审 P1-3）。
    // 刻意不带 messageId 锚：选 rewind-auto 点回退 = 撤销回退，投影侧靠「缺锚→全量」防御路径
    // 完整恢复上下文（与文件还原一致）；带「范围内最新点的锚」会让复活不完整——最新锚那轮仍被
    // 截掉，文件已还原回改后状态而模型只记得一半（终审 P1-4 声称的修法有此缺陷，测试已锁定）。
    await this.snapshotCore(sessionId, [...fileSet], { tool: 'rewind-auto' })
    const restored: string[] = []
    for (const m of [...metas].reverse()) {
      for (const f of m.files) {
        try {
          const buf = await readFile(join(this.sessionDir(sessionId), 'objects', f.hash))
          await mkdir(dirname(f.path), { recursive: true })
          await writeFile(f.path, buf)
          if (!restored.includes(f.path)) restored.push(f.path)
        } catch {
          this.warn(`还原跳过（对象缺失）：${f.path}`)
        }
      }
    }
    return { restored, externalChanged }
  }

  /** 恢复会话跟随（M9-P2 断链修复）：restoreSession 起新 sessionId，旧快照目录整体拷贝跟随。 */
  async copyForResume(oldSessionId: string, newSessionId: string): Promise<void> {
    const from = this.sessionDir(oldSessionId)
    if (!(await exists(from))) return
    await cp(from, this.sessionDir(newSessionId), { recursive: true, force: false, errorOnExist: true })
  }

  /** bash 近修改集：git status 变更文件（绝对路径）；非 git 仓库返回空 + warn。 */
  private async gitDirtyFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], { cwd: this.cwd })
      const out: string[] = []
      for (const entry of stdout.split('\0')) {
        if (entry === '') continue
        // 合法项形如 "XY path"（两状态码+空格）。rename 的 old 路径是独立 NUL 项、无状态码
        // 前缀——直接 slice(3) 会产生假路径，与真实文件撞名时误拍（"xyzkeepme.txt"→"keepme.txt"）。
        if (entry.length < 3 || entry.charCodeAt(2) !== 32) continue
        const p = entry.slice(3)
        if (p !== '') out.push(resolve(this.cwd, p))
      }
      return out
    } catch {
      this.warn('bash 快照跳过：当前目录不是 git 仓库（改动不可回退）')
      return []
    }
  }

  private async nextSeq(sessionId: string): Promise<number> {
    const dir = this.sessionDir(sessionId)
    if (!(await exists(dir))) return 1
    const entries = await readdir(dir, { withFileTypes: true })
    const seqs = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name))
    return seqs.length === 0 ? 1 : Math.max(...seqs) + 1
  }

  /** 点数上限（删最旧到上限）→ 引用集 GC → 全局会话目录上限。 */
  private async enforceLimits(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId)
    let seqs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b)
    let evicted = false
    while (seqs.length > this.maxPerSession) {
      await rm(join(dir, String(seqs[0])), { recursive: true, force: true })
      seqs = seqs.slice(1)
      evicted = true
    }
    if (evicted) await this.collectGarbage(sessionId)
    await this.enforceSessionLimit()
  }

  /** 重扫剩余 meta 引用集，回收孤儿 objects（多点共享对象只有在全部引用点被淘汰后才会成为孤儿）。 */
  private async collectGarbage(sessionId: string): Promise<void> {
    const referenced = new Set<string>()
    for (const m of await this.list(sessionId)) for (const f of m.files) referenced.add(f.hash)
    const objectsDir = join(this.sessionDir(sessionId), 'objects')
    if (!(await exists(objectsDir))) return
    for (const e of await readdir(objectsDir, { withFileTypes: true })) {
      if (e.isFile() && !referenced.has(e.name)) {
        await rm(join(objectsDir, e.name), { force: true })
      }
    }
  }

  /** 全局会话目录上限：按 mtime 淘汰最旧（整个目录删）。 */
  private async enforceSessionLimit(): Promise<void> {
    if (!(await exists(this.root))) return
    const entries = await readdir(this.root, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory())
    if (dirs.length <= this.maxSessions) return
    const withMtime = await Promise.all(
      dirs.map(async (e) => {
        const st = await stat(join(this.root, e.name))
        return { name: e.name, mtime: st.mtimeMs }
      }),
    )
    withMtime.sort((a, b) => a.mtime - b.mtime)
    const excess = withMtime.slice(0, withMtime.length - this.maxSessions)
    for (const d of excess) {
      await rm(join(this.root, d.name), { recursive: true, force: true })
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}
