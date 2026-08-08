// AgentEvent —— agent core 事件化的中心契约（UI 无关）。
// 消费方（旧 CLI wrapper / 阶段② Ink）订阅 runAgentStream 产出的事件流渲染。
//
// 注：brief 的 Interfaces 标注「Consumes ECodeStopReason」，但 brief 给定的事件结构
// 本身不含该字段（reason 用的是 AgentCompletionReason，与 LLM 层的 ECodeStopReason
// 是两个层面）。为避免 noUnusedLocals 编译错误，这里不引入未使用的 import；
// 后续 task 若需要在 completed 事件中透传底层 stopReason，再行引入。见 task-1-report.md。

import type { ECodeMessage, ECodeUsage } from './providers/types.js';

/** 请求权限的事件（可观测用，决策本身走 permissionGate 回调） */
export interface PermissionRequestEvent {
  type: 'permission_request';
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 额外原因（如 doom_loop 触发），UI 据此在弹窗里醒目提示；undefined = 普通审批。 */
  reason?: string;
}

/** agent 终止原因 */
export type AgentCompletionReason = 'done' | 'max-iterations' | 'repeated' | 'aborted';

/** agent 事件流 —— 判别联合，靠 type 字段收窄 */
export type AgentEvent =
  | { type: 'start'; task: string; model: string; provider: string; logFile?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean; input?: Record<string, unknown> }
  | PermissionRequestEvent
  | { type: 'warning'; message: string }
  | {
      type: 'completed';
      rounds: number;
      toolCalls: number;
      reason: AgentCompletionReason;
      /** 本轮结束时累积的全量 messages（含最终 assistant 回复）——REPL/续接经 resumed 回传的真相源。 */
      messages: ECodeMessage[];
      /** 会话 id（续接复用，修 REPL 每轮新会话导致的文件增殖 + 失忆）。 */
      sessionId: string;
      /** 会话首句任务（续接不覆盖此字段）。 */
      task: string;
      /** 会话创建时间（续接保持不变）。 */
      createdAt: string;
    }
  | ({ type: 'usage' } & ECodeUsage)
  | { type: 'error'; error: string };

// ---- 类型守卫（消费方收窄用）----
export const isTextDeltaEvent = (e: AgentEvent): e is Extract<AgentEvent, { type: 'text_delta' }> =>
  e.type === 'text_delta';

export const isPermissionRequestEvent = (
  e: AgentEvent,
): e is PermissionRequestEvent => e.type === 'permission_request';

export const isCompletedEvent = (
  e: AgentEvent,
): e is Extract<AgentEvent, { type: 'completed' }> => e.type === 'completed';
