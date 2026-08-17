/**
 * task_output / task_stop 工具（M10-P3）：后台任务的增量读取与终止。
 */

import type { Tool } from '../interface.js'
import { taskRegistry } from '../../services/tasks.js'

export const taskOutputTool: Tool = {
  name: 'task_output',
  description: '读取后台任务增量输出（bash run_in_background 返回的 task_id）。默认只返回上次读取之后的新内容；wait_ms 可短等新输出或退出。',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务 id（如 t3）' },
      offset: { type: 'number', description: '字节偏移（上次返回的 newOffset；缺省=自动增量）' },
      wait_ms: { type: 'number', description: '等待新输出/退出的毫秒数（≤10000）' },
    },
    required: ['task_id'],
  },
  readonly: true,

  async execute(args) {
    const { task_id, offset, wait_ms } = args as { task_id: string; offset?: number; wait_ms?: number }
    const r = taskRegistry.output(task_id, offset, wait_ms !== undefined ? Math.min(wait_ms, 10_000) : undefined)
    if ('error' in r) return { content: r.error, is_error: true }
    const tail = r.output.length > 20_000 ? `${r.output.slice(0, 10_000)}\n…（中间截断，完整用 offset 重读或看输出文件）\n${r.output.slice(-8_000)}` : r.output
    return {
      content: `状态 ${r.status}${r.exitCode !== null ? ` · exit ${r.exitCode}` : ''} · newOffset ${r.newOffset}\n${tail === '' ? '（暂无新输出）' : tail}`,
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

  async execute(args) {
    const { task_id } = args as { task_id: string }
    const r = taskRegistry.stop(task_id)
    if ('error' in r) return { content: r.error, is_error: true }
    return { content: `已发送终止信号（进程树）：#${task_id}` }
  },
}
