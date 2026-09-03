/**
 * task_output 等待根治（2026-09-03，对标 CC TaskOutput/codex write_stdin 长轮询）：
 * wait_ms 上限 10s → 300s（模型单次可等长任务，不再被迫同参连发）；
 * running 且零输出时响应带「已运行 Xs」——结果天然逐次变化，结果感知的 loop-guard
 * 不再把合法等待判成空转（真机 8 连发误伤的根治锚）。
 */
import { describe, expect, it } from 'vitest'
import { taskOutputTool, TASK_OUTPUT_MAX_WAIT_MS } from '../../../src/tools/builtin/task_tools.js'
import type { TaskOutputResult, TaskRegistry } from '../../../src/services/tasks.js'
import type { ToolContext } from '../../../src/tools/interface.js'

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

/** 假任务表：记录调用参数，按工厂返回结果（startedAt 可随调用变化——模拟时间推进） */
function fakeTasks(result: () => TaskOutputResult) {
  const calls: Array<{ offset?: number; waitMs?: number }> = []
  const registry = {
    output: async (_id: string, offset?: number, waitMs?: number) => {
      calls.push({ offset, waitMs })
      return result()
    },
  }
  return { registry: registry as unknown as TaskRegistry, calls }
}

const running = (startedAt: number): TaskOutputResult => ({
  output: '',
  newOffset: 0,
  status: 'running',
  exitCode: null,
  startedAt,
})

describe('task_output 等待根治（2026-09-03）', () => {
  it(`wait_ms 超上限被钳到 ${TASK_OUTPUT_MAX_WAIT_MS}（单次可等长任务）`, async () => {
    const { registry, calls } = fakeTasks(() => running(Date.now() - 1000))
    const r = await taskOutputTool.execute({ task_id: 't1', wait_ms: 999_999 }, { ...ctx, tasks: registry })
    expect(r.is_error).toBeFalsy()
    expect(TASK_OUTPUT_MAX_WAIT_MS).toBe(300_000)
    expect(calls[0]?.waitMs).toBe(300_000)
  })

  it('running 零输出：响应含「已运行 Xs」（终态不含——重复读已结束任务仍是静态结果）', async () => {
    const { registry } = fakeTasks(() => running(Date.now() - 5_000))
    const r = await taskOutputTool.execute({ task_id: 't1' }, { ...ctx, tasks: registry })
    expect(r.content).toContain('状态 running')
    expect(r.content).toMatch(/已运行 \d+s/)
    expect(r.content).toContain('暂无新输出')

    const done = { output: 'final', newOffset: 5, status: 'completed' as const, exitCode: 0, startedAt: Date.now() - 60_000 }
    const { registry: reg2 } = fakeTasks(() => done)
    const r2 = await taskOutputTool.execute({ task_id: 't1' }, { ...ctx, tasks: reg2 })
    expect(r2.content).toContain('exit 0')
    expect(r2.content).not.toContain('已运行')
  })

  it('本批核心：已运行时长随调用推进 → 响应内容逐次不同（loop-guard 同参同果签名被天然打破）', async () => {
    let call = 0
    const { registry } = fakeTasks(() => running(Date.now() - (call + 1) * 10_000))
    const c1 = await taskOutputTool.execute({ task_id: 't5', wait_ms: 10_000 }, { ...ctx, tasks: registry })
    call += 1
    const c2 = await taskOutputTool.execute({ task_id: 't5', wait_ms: 10_000 }, { ...ctx, tasks: registry })
    expect(c1.content).not.toBe(c2.content) // 真机误伤形态（8 次同参）在此断点
  })
})
