/**
 * todo 任务清单工具（M11-P6 / v1.2 方案 §6）。
 *
 * builtin 静态注册（无动态父要素——与 task 的装配期工厂成对照）。
 * 全量替换语义（每次写完整清单，两家同构）：LLM 漏项/重排天然自洽。
 * 状态归宿：消息即状态（投影内最后一次 todo 调用的 input）——无独立 Store，
 * rewind 跳过旧清单 / /history 恢复重放，一致性免费（方案 D18）。
 * readonly:true：写的是对话内清单，无文件/网络副作用——并行池+免确认。
 * 子代理禁配（裁剪排除，方案 D20）：清单主权归主 agent。
 */

import type { Tool } from '../interface.js'

/** 单项 content 长度上限（AJV） */
const CONTENT_MAX = 200
/** 清单项数上限（20 行已在活动区合理范围内；超限 AJV 拒绝转 is_error 自纠） */
const MAX_ITEMS = 20

const STATUS_DESC = "'pending' | 'in_progress' | 'completed'"

export const todoTool: Tool = {
  name: 'todo',
  description: `维护当前任务清单（全量替换：每次传入完整清单）。

何时用：3 步以上的多步任务才建清单；每完成一项立即更新状态；同一时间只保持一项 in_progress；全部完成后整体标 completed 收尾。
何时不该用：单步任务/小改动/纯问答不建清单（噪声大于价值）。
content 写法：短句概括动作与对象（如「重构 loop.ts 停止判定」），不复述上下文。`,
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整清单（全量替换——包含所有未完成与已完成项）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '任务项（短句，≤200 字符）', minLength: 1, maxLength: CONTENT_MAX },
            status: { type: 'string', description: STATUS_DESC, enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
        maxItems: MAX_ITEMS,
      },
    },
    required: ['todos'],
  },
  readonly: true,
  async execute(args) {
    const { todos } = args as { todos: Array<{ content: string; status: string }> }
    const done = todos.filter((t) => t.status === 'completed').length
    const next = todos.find((t) => t.status === 'in_progress')
    return {
      content: `清单已更新（${done}/${todos.length} 完成${next !== undefined ? `，进行中：${next.content}` : ''}）。继续用清单跟踪进度，完成一项立即更新。`,
    }
  },
}
