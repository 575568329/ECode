// Todo 工具 + 类型（M3.5 Step 3：消息队列与交互重做方案 §6）。
//
// 整表替换语义（对齐 CC TodoWrite）：agent 每次给全量 todos，UI 据此派生常驻面板渲染。
// 不增量更新——agent 自己维护「完成到哪了」，每次重发完整清单。
//
// 复杂任务（3 步以上）才用：先规划 todo，推进时标 in_progress、完成标 completed。
// 简单问答/单步任务禁用 todo_write（会污染常驻面板）。
//
// UI 派生（§7.3：agent.ts/agent-events.ts 不改）：use-agent-stream 拦截 todo_write 的
// tool_call_start + tool_result，从 input.todos 派生 state.todos，不进 reducer
// （避免 activeTools 残留 + completedMessages 多一条 tool 行）。

import type { ToolResult } from './types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** 进行中项的现在进行时描述（可选，对齐 CC activeForm，如「正在读取配置」）。
   *  UI 派生时若提供则优先显示 activeForm，否则显示 content。 */
  activeForm?: string;
}

/** status 收窄 + 兜底：未知值降级为 pending（容错模型乱传）。 */
function normalizeTodoStatus(v: unknown): TodoStatus {
  if (v === 'pending' || v === 'in_progress' || v === 'completed') return v;
  return 'pending';
}

/**
 * 从 todo_write 工具输入派生 TodoItem[]（UI 派生 + executor 执行共用同一净化逻辑）。
 * 容错：input 缺失 / todos 非数组 / 项畸形 → 返回 null（调用方保持旧 todos）。
 * 导出供单测 + use-agent-stream 拦截调用。
 */
export function extractTodos(input?: Record<string, unknown>): TodoItem[] | null {
  if (!input || !Array.isArray(input.todos)) return null;
  return (input.todos as unknown[])
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      content: typeof t.content === 'string' ? t.content : String(t.content ?? ''),
      status: normalizeTodoStatus(t.status),
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    }))
    .filter((t) => t.content.length > 0); // 空 content 无意义，丢弃
}

/**
 * todo_write 执行器：整表替换（无副作用，只回执）。
 * UI 已在 tool_call_start 派生渲染，这里仅给 LLM 一个确认回执（模型据此规划下一步）。
 */
export function executeTodoWrite(input: Record<string, unknown>): ToolResult {
  const todos = extractTodos(input) ?? [];
  if (todos.length === 0) {
    return { content: '已清空 todo 列表。', isError: false };
  }
  const lines = todos.map((t, i) => {
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '◻';
    return `${i + 1}. ${mark} ${t.content}`;
  });
  return {
    content: `已更新 ${todos.length} 项 todo：\n${lines.join('\n')}`,
    isError: false,
  };
}
