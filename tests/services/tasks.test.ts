/** 后台任务测（M10-P3）：真子进程（echo/sleep）+ 增量读 + 杀树 + 通知去重 + bash 分流 + dispose。 */
import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRegistry } from '../../src/services/tasks.js'
import { bashTool } from '../../src/tools/builtin/bash.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecode-tasks-'))
})

describe('TaskRegistry', () => {
  it('start → 立即返回 id；输出直写文件；完成后状态 completed', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo hello-task', process.cwd())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    // 等命令完成（echo 毫秒级；轮询）
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    const out = await reg.output(r.task.id)
    expect(out.status).toBe('completed')
    if ('output' in out) expect(out.output).toContain('hello-task')
  })

  it('output() 带 startedAt（2026-09-03 等待根治：task_output 渲染已运行时长的数据源）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo uptime-src', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    const t0 = Date.now()
    const first = await reg.output(r.task.id)
    if ('error' in first) throw new Error('bad')
    // 审阅收紧：真实启动时刻=start 内赋值（必 ≤ 读时刻 t0），且不会早于 start 调用 5s——
    // 旧断言 t0-60_000 几乎恒真，实现若退化为「返回读取时刻」仍绿
    expect(first.startedAt).toBeLessThanOrEqual(t0)
    expect(first.startedAt).toBeGreaterThan(t0 - 5_000)
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    const done = await reg.output(r.task.id)
    if ('error' in done) throw new Error('bad')
    expect(done.startedAt).toBe(first.startedAt) // 终态仍带（消费端按 status 决定是否渲染）
  })

  // 审阅 P1（等待路径零直接测试）：waitMs 机制本体两条路径补真子进程锚
  it('waitMs 等待：running 中新输出到达提前返回（一次等到，不空转）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('sleep 1 && echo late-output', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    const out = await reg.output(r.task.id, 0, 8000)
    if ('error' in out) throw new Error('bad')
    expect(out.output).toContain('late-output')
  }, 12_000)

  it('waitMs 到期：全程无输出 → 返回 running 态空输出（不抛错、不误报完成）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('sleep 5', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    const out = await reg.output(r.task.id, 0, 300)
    if ('error' in out) throw new Error('bad')
    expect(out.status).toBe('running')
    expect(out.output).toBe('')
    reg.stop(r.task.id)
    reg.cleanup()
  }, 10_000)

  it('增量读：两次读不重复（consumedOffset 推进）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo line1', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    const first = await reg.output(r.task.id)
    if (!('output' in first)) throw new Error('bad')
    expect(first.output).toContain('line1')
    const second = await reg.output(r.task.id)
    if (!('output' in second)) throw new Error('bad')
    expect(second.output).toBe('') // 已消费，无新输出
  })

  it('stop → running 任务被杀（状态 stopped）；不存在 id 报错', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start(process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    expect(reg.hasRunning()).toBe(true)
    const stop = reg.stop(r.task.id)
    expect('stopped' in stop && stop.stopped).toBe(true)
    await waitFor(async () => (await reg.output(r.task.id)).status === 'stopped', 5000)
    expect(await reg.output(r.task.id)).toMatchObject({ status: 'stopped' }) // 退出码非 0/null
    expect('error' in (await reg.output('nope'))).toBe(true)
  })

  it('完成通知：collectNotifications 一次返回后标记（不重复）；running 不通知（2026-09-03 归属根治：结构化 {text, meta}）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo done-note', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    expect(reg.collectNotifications()).toHaveLength(0) // running 不通知
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    const notes = reg.collectNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toContain(r.task.id)
    expect(notes[0].meta).toEqual({ kind: 'task-notify' }) // 机器消息标记（UI 分流依据）
    expect(reg.collectNotifications()).toHaveLength(0) // 已通知不重复
  })

  it('并发上限 8：第 9 个拒绝（可读 reason）', async () => {
    const reg = new TaskRegistry(dir)
    const cmd = process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10'
    for (let i = 0; i < 8; i += 1) {
      const r = reg.start(cmd, process.cwd())
      expect(r.ok).toBe(true)
    }
    const ninth = reg.start('echo x', process.cwd())
    expect(ninth.ok).toBe(false)
    if (!ninth.ok) expect(ninth.reason).toContain('8')
    reg.cleanup()
  }, 15_000)

  it('指定 offset 的部分读：只返回增量且不推进 consumedOffset', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo partial-read', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    const mid = await reg.output(r.task.id, 0)
    if ('output' in mid) expect(mid.output).toContain('partial-read')
    const again = await reg.output(r.task.id, mid.newOffset)
    if ('output' in again) expect(again.output).toBe('') // 从已读 offset 续读 → 无增量
  })

  it('dispose：unlink 本会话输出文件 + 清空任务表（gracefulShutdown 接线语义）', async () => {
    const reg = new TaskRegistry(dir)
    const r = reg.start('echo dispose-me', process.cwd())
    if (!r.ok) throw new Error('任务 start 失败：' + r.reason)
    await waitFor(async () => (await reg.output(r.task.id, 0)).status !== 'running', 5000)
    expect(existsSync(r.task.outputFile)).toBe(true)
    reg.dispose()
    expect(existsSync(r.task.outputFile)).toBe(false)
    expect('error' in (await reg.output(r.task.id))).toBe(true) // 表已清空
  })
})

describe('bash run_in_background 分流', () => {
  it('run_in_background=true → 立即返回 task_id 提示；不阻塞', async () => {
    const ctx = { cwd: process.cwd(), signal: new AbortController().signal }
    const r = await bashTool.execute(
      { command: process.platform === 'win32' ? 'ping -n 5 127.0.0.1' : 'sleep 5', run_in_background: true },
      ctx,
    )
    expect(r.is_error).toBeFalsy()
    expect(r.content).toMatch(/后台任务已启动：#t\d+/)
    expect(r.content).toContain('task_output')
  }, 10_000)
})

/** waitFor 支持 async 条件（output 已 async 化——终审 P1-4） */
function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      void Promise.resolve(cond())
        .then((ok) => {
          if (ok) return resolve()
          if (Date.now() - t0 > ms) return reject(new Error('waitFor 超时'))
          setTimeout(tick, 50)
        })
        .catch(reject)
    }
    tick()
  })
}
