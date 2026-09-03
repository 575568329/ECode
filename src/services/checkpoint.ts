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
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MAX_PER_SESSION = 100
export const MAX_SESSIONS = 50
export const MAX_FILE_BYTES = 10 * 1024 * 1024

export interface CheckpointFileRef {
  /** 绝对路径（正斜杠规范化由调用方保证；此处原样存储） */
  path: string
  hash: string
  /** 审阅修复（2026-09-03 全功能走查）：快照时刻文件不存在（新建前/删除后）——revert 到该点
   *  = 删除此路径。原实现「无基线可拍，跳过」→ /rewind 对新建文件永远不删（消息回退了文件
   *  残留，P1 UX 缺口；真机 dogfood 实证）。 */
  absent?: true
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
  /** 审阅修复（二轮）：写回阶段单项失败清单（目录占用/EBUSY 等——其余项已完成） */
  failed?: string[]
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

  /** 串行链排队执行（快照/revert 计划段/目录拷贝共用——互斥防 TOCTOU）；失败不阻塞后续 */
  private enqueueChain<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
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
      // 审阅修复（开发席 P2·二轮）：absent 判定只源于**源文件读**的 ENOENT——对象库写
      // （mkdir/writeFile）原与源读同 try，对象库故障的 ENOENT 会把存在的文件误记 absent
      //（后续 revert 即误删真文件）。对象库写独立 catch（失败跳过该文件——无基线不拍）
      let buf: Buffer
      try {
        const st = await stat(p)
        if (st.size > this.maxFileBytes) {
          this.warn(`快照跳过（超过 ${Math.round(this.maxFileBytes / 1024 / 1024)}MB）：${p}`)
          continue
        }
        buf = await readFile(p)
      } catch (e) {
        // 文件不存在（新建前/git 已删）：记 absent 基线——revert 到该点即删除此路径
        //（原「跳过」致新建文件不可回退）。其他读失败（权限/占用）仍跳过不拍。
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
          refs.push({ path: p, hash: '', absent: true })
        } else {
          this.warn(`快照跳过（读取失败 ${String((e as NodeJS.ErrnoException)?.code ?? '')}）：${p}`)
        }
        continue
      }
      try {
        const hash = sha256(buf)
        const objFile = join(this.sessionDir(sessionId), 'objects', hash)
        if (!(await exists(objFile))) {
          // 0700：快照含工作区文件内容，目录权限即安全边界（与会话/配置目录同款收口）
          await mkdir(dirname(objFile), { recursive: true, mode: 0o700 })
          await writeFile(objFile, buf)
        }
        refs.push({ path: p, hash })
      } catch (e) {
        this.warn(`快照跳过（对象库写失败 ${String((e as NodeJS.ErrnoException)?.code ?? '')}）：${p}`)
      }
    }
    if (refs.length === 0) return null
    const seq = (await this.nextSeq(sessionId))
    const m: CheckpointMeta = { seq, time: new Date().toISOString(), tool: meta.tool, messageId: meta.messageId, files: refs }
    await mkdir(join(this.sessionDir(sessionId), String(seq)), { recursive: true, mode: 0o700 })
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
   * 审阅修复（架构/开发/安全席三席收敛·二轮）：absent 项对称检测——文件**当前存在**即
   * 报告（还原将删除，删用户手改前明示）；metas 预载参数供 rewind 面板复用（原每点全量
   * 重扫 O(点²)）。
   */
  async detectExternalChanges(sessionId: string, seq: number, preloaded?: CheckpointMeta[]): Promise<string[]> {
    const metas = (preloaded ?? (await this.list(sessionId))).filter((m) => m.seq >= seq)
    const latest = new Map<string, string | null>() // null = absent 基线
    for (const m of metas) for (const f of m.files) latest.set(f.path, f.absent === true ? null : f.hash)
    const changed: string[] = []
    for (const [p, base] of latest) {
      try {
        if (base === null) {
          // absent 基线 + 文件当前存在 = 快照后出现（ECode 写的或用户手建的）——还原将删除
          await stat(p)
          changed.push(p)
        } else if (sha256(await readFile(p)) !== base) {
          changed.push(p)
        }
      } catch {
        // 内容基线 + 文件已被删除：还原会重建，不算外部修改
      }
    }
    return changed
  }

  /**
   * 还原：选中点（含）及之后全部快照逆序写回 = 回到该点执行前。
   * 还原前先对涉及文件拍 rewind-auto 点（撤销可撤销）。外部改动只报告不拦截（调用方确认页用）。
   * 审阅修复（架构席 P2·二轮）：读 metas/建 plans 段入串行链——与并发快照（M11 子代理写前
   * 快照走同一 store）互斥，消灭 revert 读到链上未落盘 seq 的 TOCTOU；写回阶段留链外不阻塞。
   * 审阅修复（安全/开发席 P2·二轮）：写回 per-plan 容错——absent 路径后被建成目录/EBUSY 等
   * 单项失败不再中断整个还原留半程状态，失败清单汇总返回（failed）。
   */
  async revert(sessionId: string, seq: number): Promise<RevertResult> {
    // 阶段 0+1（链上）：范围 metas + 外检 + 计划构建（读对象+哈希复验）
    const planPhase = this.enqueueChain(async () => {
      const metas = (await this.list(sessionId)).filter((m) => m.seq >= seq)
      if (metas.length === 0) throw new Error(`快照点 ${seq} 不存在`)
      const externalChanged = await this.detectExternalChanges(sessionId, seq, metas)
      // 第一阶段（安全审阅 P2-a）：全量读对象 + 哈希复验后才动任何文件——content-addressed 的
      // 意义就在哈希即身份，对象被篡改/位腐后直接写回即静默写坏数据。任一哈希不符 → 整体拒绝
      //（写回零执行）。对象缺失保持既有语义（warn 跳过——快照治理边界情况，非篡改特征）。
      const plans: Array<{ path: string; buf?: Buffer }> = []
      for (const m of [...metas].reverse()) {
        for (const f of m.files) {
          // absent 基线：revert 到该点=删除此路径（buf 缺省=删除计划；存在才删，force 幂等）
          if (f.absent === true) {
            plans.push({ path: f.path })
            continue
          }
          let buf: Buffer
          try {
            buf = await readFile(join(this.sessionDir(sessionId), 'objects', f.hash))
          } catch {
            this.warn(`还原跳过（对象缺失）：${f.path}`)
            continue
          }
          const actual = sha256(buf)
          if (actual !== f.hash) {
            throw new Error(`还原中止：对象内容与哈希不符（疑被篡改或损坏），拒绝写回——${f.path} 期望 ${f.hash}，实际 ${actual}（本次还原未执行任何写入）`)
          }
          plans.push({ path: f.path, buf })
        }
      }
      return { externalChanged, plans }
    })
    const { externalChanged, plans } = await planPhase
    const fileSet = [...new Set(plans.map((p) => p.path))]
    // 还原前自动快照当前状态（含外部改动后的现状——回错了可再 revert 回来）。
    // 走 snapshotCore：此时治理会淘汰最旧点/GC 对象，可能删掉本次正要写回的基线（终审 P1-3）。
    // 刻意不带 messageId 锚：选 rewind-auto 点回退 = 撤销回退，投影侧靠「缺锚→全量」防御路径
    // 完整恢复上下文（与文件还原一致）；带「范围内最新点的锚」会让复活不完整——最新锚那轮仍被
    // 截掉，文件已还原回改后状态而模型只记得一半（终审 P1-4 声称的修法有此缺陷，测试已锁定）。
    await this.snapshotCore(sessionId, fileSet, { tool: 'rewind-auto' })
    const restored: string[] = []
    const failed: string[] = []
    // 第二阶段（链外）：写回（逆序 metas 顺序——同文件多版本时最后写的生效 = 范围内最早基线）。
    // tmp+rename 原子替换（安全审阅 P2-b）：writeFile 直接开目标路径会**跟随 symlink**——
    // 攻击者预先在目标路径放 symlink 指向敏感文件（如 ~/.ssh/authorized_keys），还原写入即
    // 穿透。write/edit 工具是 tmp+rename 替换链接本身，还原保持同款行为；tmp 放同目录保证
    // rename 同分区原子性，名带 pid+时间戳防并发互踩。
    for (const p of plans) {
      try {
        if (p.buf === undefined) {
          // absent 还原=删除（快照时刻不存在；撤销撤销时还原前自动快照已拍下现存内容）
          await rm(p.path, { force: true })
        } else {
          await mkdir(dirname(p.path), { recursive: true, mode: 0o700 })
          const tmp = join(dirname(p.path), `.${basename(p.path)}.ecode-restore-${process.pid}-${Date.now()}`)
          try {
            await writeFile(tmp, p.buf)
            await rename(tmp, p.path)
          } finally {
            await rm(tmp, { force: true }) // rename 成功后 tmp 已不存在，force 静默清理
          }
        }
        if (!restored.includes(p.path)) restored.push(p.path)
      } catch (e) {
        // 单项失败不中断（否则前序已写项+未写项=半程还原无反馈）——汇总报告
        this.warn(`还原失败（${String((e as NodeJS.ErrnoException)?.code ?? e)}）：${p.path}`)
        if (!failed.includes(p.path)) failed.push(p.path)
      }
    }
    return { restored, externalChanged, ...(failed.length > 0 ? { failed } : {}) }
  }

  /**
   * absent 基线补录（二轮审阅·bash absent 兜底）：把「执行 bash 前不存在」的路径补进
   * **最近一个快照点**（bash 的写前快照）——revert 到该点即可删除 bash 新建的文件
   *（npm install/构建脚本类写路径原对 /rewind 完全失明）。
   * 链上串行；只补该点尚无记录的路径（已有 present/absent 基线不覆盖）；无快照点时静默跳过
   *（无点可锚——bash 前无任何写入，差集文件也不存在，删除它们无基线语义可依）。
   */
  async amendAbsent(sessionId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.enqueueChain(async () => {
      const metas = await this.list(sessionId)
      const latest = metas[metas.length - 1]
      if (latest === undefined) return
      const known = new Set(latest.files.map((f) => f.path))
      const add = paths.filter((p) => !known.has(p))
      if (add.length === 0) return
      latest.files = [...latest.files, ...add.map((p) => ({ path: p, hash: '', absent: true as const }))]
      await writeFile(join(this.sessionDir(sessionId), String(latest.seq), 'meta.json'), JSON.stringify(latest, null, 2), 'utf8')
    })
  }

  /** 恢复会话跟随（M9-P2 断链修复）：restoreSession 起新 sessionId，旧快照目录整体拷贝跟随。
   *  审阅修复（架构席 P2·二轮）：入串行链——防拷到链上正写一半的 meta.json。 */
  async copyForResume(oldSessionId: string, newSessionId: string): Promise<void> {
    const from = this.sessionDir(oldSessionId)
    if (!(await exists(from))) return
    await this.enqueueChain(() => cp(from, this.sessionDir(newSessionId), { recursive: true, force: false, errorOnExist: true }))
  }

  /** bash 近修改集：git status 变更文件（绝对路径）；非 git 仓库返回空 + warn。 */
  /** bash absent 兜底（二轮补遗）：近修改集公开包装——session 桥在 bash 前后各取一次做差集 */
  async bashDirtyFiles(): Promise<string[]> {
    return this.gitDirtyFiles()
  }

  private async gitDirtyFiles(): Promise<string[]> {
    try {
      // windowsHide：本函数在每次 bash/编辑工具前触发（daemon 无控制台形态下 git.exe
      // 会新建控制台窗闪窗打断用户——与 proc.ts spawnShellCommand 同款压制）
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], { cwd: this.cwd, windowsHide: true })
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
