/**
 * TaskRegistry：后台子进程任务（M10-P3）。
 *
 * bash run_in_background=true 时登记：stdio 直写输出文件（CC file mode 同款零 JS 开销），
 * 立即返回 task_id；task_output 增量读（offset 语义）；task_stop 走统一杀树（proc.killTree，
 * v1.3 先行落地）；完成通知双时点（turn 内 afterTools 检查 + 跨 turn submit 前 pending——
 * P1-7：afterTools 是 iter 级，turn 结束后完成的任务没有它可挂）。
 * 并发上限 8（codex 64 过宽 MVP 收紧）；会话结束 cleanup 全杀。
 */

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { killTree, spawnShellCommand } from './proc.js'

const MAX_CONCURRENT = 8

export interface BackgroundTask {
  id: string
  command: string
  child: ReturnType<typeof spawn>
  outputFile: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  exitCode: number | null
  startedAt: number
  /** 已被 task_output 消费过的偏移（增量语义） */
  consumedOffset: number
  /** 完成后是否已通知（防重复注入） */
  notified: boolean
}

export interface TaskStartResult {
  ok: true
  task: { id: string; outputFile: string }
}

export interface TaskOutputResult {
  output: string
  newOffset: number
  status: BackgroundTask['status']
  exitCode: number | null
}

let seq = 0

export class TaskRegistry {
  private tasks = new Map<string, BackgroundTask>()
  private readonly outDir: string

  constructor(outDir?: string) {
    this.outDir = outDir ?? join(homedir(), '.ecode', 'tmp')
    try {
      mkdirSync(this.outDir, { recursive: true })
    } catch {
      // 无权限等：启动任务时报错
    }
  }

  /** 启动后台任务：输出直写文件，立即返回 id。满载/启动失败返回可读 reason。 */
  start(command: string, cwd: string): TaskStartResult | { ok: false; reason: string } {
    const running = [...this.tasks.values()].filter((t) => t.status === 'running').length
    if (running >= MAX_CONCURRENT) {
      return { ok: false, reason: `后台任务已达上限 ${MAX_CONCURRENT}（等待完成或 task_stop 释放）` }
    }
    seq += 1
    const id = `t${seq}`
    const outputFile = join(this.outDir, `task-${id}.log`)
    let child: ReturnType<typeof spawn>
    try {
      child = spawnShellCommand(command, cwd)
      // stdio 中转写文件（终审 P2-4：双流 pipe 同一 writeStream——先 end 的流会关目标丢另一流尾部，
      // { end: false } + 两个都结束后才关）
      const ws = createWriteStream(outputFile, { flags: 'w' })
      let openStreams = 0
      const pipe = (stream: NodeJS.ReadableStream | null): void => {
        if (stream === null) return
        openStreams += 1
        const done = (): void => {
          openStreams -= 1
          if (openStreams === 0) ws.end()
        }
        stream.pipe(ws, { end: false })
        stream.on('end', done)
        // 复审 P2-5：流 error 不 emit end——计数不归零则 ws 永不 close（fd 泄漏+事件循环保活）
        stream.on('close', done)
        stream.on('error', done)
      }
      pipe(child.stdout)
      pipe(child.stderr)
      ws.on('error', () => {})
    } catch (e) {
      return { ok: false, reason: `启动失败：${e instanceof Error ? e.message : String(e)}` }
    }
    const task: BackgroundTask = {
      id,
      command,
      child,
      outputFile,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      consumedOffset: 0,
      notified: false,
    }
    this.tasks.set(id, task)
    child.on('close', (code) => {
      task.status = code === 0 ? 'completed' : code === null ? 'stopped' : 'failed'
      task.exitCode = code
      // 终审 P1-6：任务完成钩子——装配层接 checkpoint 近修改集快照（后台任务期间改的干净文件盲区收口）
      if (task.status !== 'stopped') {
        try {
          this.onComplete?.({ command: task.command })
        } catch {
          // 钩子失败不影响任务状态记录
        }
      }
    })
    child.on('error', () => {
      task.status = 'failed'
    })
    return { ok: true, task: { id, outputFile } }
  }

  /**
   * 增量读取：从 consumedOffset（或指定字节 offset）到文件末尾。
   * async + setTimeout 轮询（终审 P1-4：Atomics.wait 同步阻塞会冻结 Ink 渲染与 Ctrl+C 最长 10s）。
   * newOffset = 文件末尾（终审 P2-3：多字节 UTF-8 中间截断按字符数回算会漂移——按字节末尾对齐，
   * 多字节字符跨读边界会产替换符（解码文本失真但文件字节不丢，日志场景容忍））。
   */
  async output(id: string, offset?: number, waitMs?: number): Promise<TaskOutputResult | { error: string }> {
    const task = this.tasks.get(id)
    if (task === undefined) return { error: `任务 ${id} 不存在` }
    const read = (): TaskOutputResult => {
      const start = offset ?? task.consumedOffset
      let buf = Buffer.alloc(0)
      try {
        buf = readFileSync(task.outputFile)
      } catch {
        // 文件暂不可读：空输出
      }
      const text = buf.length > start ? buf.subarray(start).toString('utf8') : ''
      const newOffset = buf.length
      if (offset === undefined) task.consumedOffset = newOffset
      return { output: text, newOffset, status: task.status, exitCode: task.exitCode }
    }
    if (waitMs !== undefined && waitMs > 0 && task.status === 'running') {
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && task.status === 'running') {
        const r = read()
        if (r.output.length > 0) return r
        await sleep(50)
      }
    }
    return read()
  }

  /** 停止任务（统一杀树）。 */
  stop(id: string): { stopped: true } | { error: string } {
    const task = this.tasks.get(id)
    if (task === undefined) return { error: `任务 ${id} 不存在` }
    if (task.status !== 'running') return { stopped: true }
    void killTree(task.child).then(() => {
      task.status = 'stopped'
    })
    return { stopped: true }
  }

  /** turn 内 afterTools 检查点：已完成且未通知的任务 → 生成摘要并标记（防重复）。 */
  collectNotifications(): string[] {
    const notes: string[] = []
    for (const t of this.tasks.values()) {
      if (!t.notified && (t.status === 'completed' || t.status === 'failed')) {
        t.notified = true
        notes.push(`[task] #${t.id}（${t.command.slice(0, 60)}）已${t.status === 'completed' ? '完成' : '失败'} exit ${t.exitCode ?? '?'}——输出可用 task_output("${t.id}") 读取`)
      }
    }
    return notes
  }

  /** 有活跃任务（/rewind 面板守卫用——M9 runningRef 的扩展）。 */
  hasRunning(): boolean {
    return [...this.tasks.values()].some((t) => t.status === 'running')
  }

  /** 会话结束/退出：全杀（gracefulShutdown 预算内调用）。 */
  cleanup(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') void killTree(t.child)
    }
    this.tasks.clear()
  }

  /** 任务完成时补拍快照的钩子注入位（M10-P1-8：后台任务期间改的干净文件无快照的盲区收口）。 */
  onComplete?: (task: { command: string }) => void
}

/** 异步睡（不阻塞事件循环——Atomics.wait 会冻结渲染线程） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 模块级单例（bash 工具/TuiApp/清理钩子共享；测试可 new 独立实例注入） */
export const taskRegistry = new TaskRegistry()
