// 纯函数状态机：AgentEvent → StreamState（spec §5.1 事件分发逻辑）。
// 无 React 依赖，核心状态转换全在此可测。useAgentStream hook 包它接 React。
import type { AgentEvent } from '../agent-events.js';
import { initialStreamState, type StreamState, type DisplayMessage } from './types.js';

/** 单调递增 id 生成（reducer 内部用，保证 DisplayMessage 稳定 key）。 */
let msgSeq = 0;
const nextId = (): string => `m${++msgSeq}`;

/**
 * 把一个 AgentEvent 折进 state，返回新 state（不可变）。
 * - text_delta → streamingText 累加
 * - tool_call_start → activeTools 追加
 * - tool_result → activeTools 移除 + completedMessages 追加 kind:tool
 * - permission_request → pendingPermission 挂起
 * - completed → streamingText 落地 kind:assistant + isRunning=false
 * - usage → 累计 token
 * - warning/error → 落地系统消息
 */
export function reduceAgentEvent(state: StreamState, event: AgentEvent): StreamState {
  switch (event.type) {
    case 'start':
      // 记录 currentModel + runStartedAt：assistant MetaLine（模型名 / 耗时）的数据源。
      return { ...state, isRunning: true, error: null, currentModel: event.model, runStartedAt: Date.now() };

    case 'text_delta':
      return { ...state, streamingText: (state.streamingText ?? '') + event.text };

    case 'tool_call_start':
      return {
        ...state,
        activeTools: [...state.activeTools, { id: event.id, name: event.name, startedAt: Date.now(), input: event.input }],
      };

    case 'tool_result': {
      const activeTools = state.activeTools.filter((t) => t.id !== event.id);
      // §9.5 input 透传：优先用事件自带 input，兜底从 activeTool 回填（容错：事件缺字段时不丢摘要）
      const fallbackInput = state.activeTools.find((t) => t.id === event.id)?.input;
      const msg: DisplayMessage = {
        kind: 'tool',
        id: nextId(),
        name: event.name,
        content: event.content,
        isError: event.isError,
        input: event.input ?? fallbackInput,
      };
      return { ...state, activeTools, completedMessages: [...state.completedMessages, msg] };
    }

    case 'permission_request':
      return {
        ...state,
        pendingPermission: {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
        },
      };

    case 'completed': {
      const msgs = [...state.completedMessages];
      if (state.streamingText) {
        // 落地助手文本时附带 MetaLine 数据：模型名 + 本轮耗时（start→completed）。
        msgs.push({
          kind: 'assistant',
          id: nextId(),
          text: state.streamingText,
          model: state.currentModel ?? undefined,
          durationMs:
            state.runStartedAt != null ? Date.now() - state.runStartedAt : undefined,
        });
      }
      return {
        ...state,
        completedMessages: msgs,
        streamingText: null,
        isRunning: false,
        lastCompleted: { rounds: event.rounds, reason: event.reason },
      };
    }

    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + event.inputTokens,
          outputTokens: state.usage.outputTokens + event.outputTokens,
        },
      };

    case 'warning':
      return {
        ...state,
        completedMessages: [...state.completedMessages, { kind: 'warning', id: nextId(), text: event.message }],
      };

    case 'error':
      return {
        ...state,
        isRunning: false,
        error: event.error,
        completedMessages: [...state.completedMessages, { kind: 'error', id: nextId(), text: event.error }],
      };

    default: {
      // exhaustive（noFallthroughCasesInSwitch + 类型守卫）
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

export { initialStreamState };
