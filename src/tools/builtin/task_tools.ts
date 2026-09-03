/**
 * task_output / task_stop 工具（M10-P3）：后台任务的增量读取与终止。
 *
 * 2026-09-03 等待根治：wait_ms 上限 10s → 5 分钟（对标 codex 空轮询 5min / CC TaskOutput
 * block 10min），running 且零输出时响应带「已运行 Xs」——结果逐次变化，结果感知的
 * loop-guard 不再把合法等待判成同参空转（真机 8 连发误伤的根治）。
 */

import type { Tool } from '../interface.js'
import { taskRegistry, TASK_OUTPUT_MAX_WAIT_MS } from '../../services/tasks.js'

export { TASK_OUTPUT_MAX_WAIT_MS } from '../../services/tasks.js'

export const taskOutputTool: Tool = {
  name: 'task_output',
  description: `读取后台任务增量输出（bash run_in_background 返回的 task_id）。默认只返回上次读取之后的新内容；wait_ms 可等待新输出或任务退出（上限 ${TASK_OUTPUT_MAX_WAIT_MS}=${TASK_OUTPUT_MAX_WAIT_MS / 1000 / 60} 分钟，等待中有新输出或任务结束会提前返回）。等长任务请单次给足 wait_ms 一次等到，勿短间隔同参连发（会触发 loop-guard 同参检测）。`,
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务 id（如 t3）' },
      offset: { type: 'number', description: '字节偏移（上次返回的 newOffset；缺省=自动增量）' },
      wait_ms: { type: 'number', description: `等待新输出/退出的毫秒数（≤${TASK_OUTPUT_MAX_WAIT_MS}；长任务单次给足，如 60000-${TASK_OUTPUT_MAX_WAIT_MS}）` },
    },
    required: ['task_id'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { task_id, offset, wait_ms } = args as { task_id: string; offset?: number; wait_ms?: number }
    const r = await (ctx.tasks ?? taskRegistry).output(task_id, offset, wait_ms !== undefined ? Math.min(wait_ms, TASK_OUTPUT_MAX_WAIT_MS) : undefined)
    if ('error' in r) return { content: r.error, is_error: true }
    const tail = r.output.length > 20_000 ? `${r.output.slice(0, 10_000)}\n…（中间截断，完整用 offset 重读或看输出文件）\n${r.output.slice(-8_000)}` : r.output
    // 已运行时长只在 running 态渲染：等待期结果逐次变化（豁免合法轮询）；终态保持静态
    // （任务已结束后复读同一份输出仍是同参同果，guard 保护不丢）
    const uptime = r.status === 'running' ? ` · 已运行 ${Math.max(1, Math.round((Date.now() - r.startedAt) / 1000))}s` : ''
    return {
      content: `状态 ${r.status}${uptime}${r.exitCode !== null ? ` · exit ${r.exitCode}` : ''} · newOffset ${r.newOffset}\n${tail === '' ? `（暂无新输出——任务仍在跑，继续等请单次给足 wait_ms（上限 ${TASK_OUTPUT_MAX_WAIT_MS}），勿短间隔连发）` : tail}`,
    }
  },
}

export const taskStopTool: Tool = {
  name: 'task_stop',
  description: '终止后台任务（统一杀树——进程组/taskkill /T /F，孙进程一并终止）。',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务 id' },
    },
    required: ['task_id'],
  },
  readonly: false,

  async execute(args, ctx) {
    const { task_id } = args as { task_id: string }
    const r = (ctx?.tasks ?? taskRegistry).stop(task_id)
    if ('error' in r) return { content: r.error, is_error: true }
    return { content: `已发送终止信号（进程树）：#${task_id}` }
  },
}
