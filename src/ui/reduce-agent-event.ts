// 纯函数状态机：AgentEvent → StreamState（spec §5.1 事件分发逻辑）。
// 无 React 依赖，核心状态转换全在此可测。useAgentStream hook 包它接 React。
import type { AgentEvent } from '../agent-events.js';
import { initialStreamState, type StreamState, type DisplayMessage } from './types.js';
import { isReadSearchTool } from './read-search-group.js';

/** 单调递增 id 生成（reducer 内部用，保证 DisplayMessage 稳定 key）。 */
let msgSeq = 0;
const nextId = (): string => `m${++msgSeq}`;

/**
 * 延迟冻结：把挂起的连续只读组合并(多条)/ 直通(单条)后追加进 completedMessages，清空 pending。
 * 纯函数，导出供单测。空 pending 无操作；单条直通(避免 "Read 1 files" 尴尬文案)；
 * 多条合并成 tool_group(Ctrl+O pager 展开 tools 看完整内容)。
 * 详见 docs/详设/20260806220000_折叠组延迟冻结-详设.md。
 */
export function flushReadSearch(state: StreamState): Pick<StreamState, 'completedMessages' | 'pendingReadSearch'> {
  const pending = state.pendingReadSearch;
  if (pending.length === 0) {
    return { completedMessages: state.completedMessages, pendingReadSearch: [] };
  }
  if (pending.length === 1) {
    // 单条：不合并，直接进 Static（避免 "Read 1 files"）
    return { completedMessages: [...state.completedMessages, pending[0]], pendingReadSearch: [] };
  }
  const tools = pending
    .filter((m): m is Extract<DisplayMessage, { kind: 'tool' }> => m.kind === 'tool')
    .map((t) => ({ name: t.name, content: t.content, isError: t.isError, input: t.input }));
  const group: DisplayMessage = { kind: 'tool_group', id: nextId(), tools };
  return { completedMessages: [...state.completedMessages, group], pendingReadSearch: [] };
}

/** 若有挂起的只读组则 flush 合并，返回新 state（无挂起原样返回）。破坏时机统一入口。 */
function flushIfNeeded(state: StreamState): StreamState {
  if (state.pendingReadSearch.length === 0) return state;
  const flushed = flushReadSearch(state);
  return { ...state, completedMessages: flushed.completedMessages, pendingReadSearch: flushed.pendingReadSearch };
}

/**
 * 把 streamingText 落地成 assistant msg + 清空（completed 与 tool_call_start 复用）。
 * 防 #2 跨轮累加：start/completed 是每 run 一次（非每轮），若不在轮边界（tool_call_start）
 * flush，多轮 text 会全堆在动态区 streamingText 里越拼越长。无 streamingText 时不 push（避免空 assistant）。
 */
function flushStreamingText(state: StreamState): Pick<StreamState, 'completedMessages' | 'streamingText'> {
  if (!state.streamingText) {
    return { completedMessages: state.completedMessages, streamingText: state.streamingText };
  }
  return {
    completedMessages: [
      ...state.completedMessages,
      {
        kind: 'assistant',
        id: nextId(),
        text: state.streamingText,
        model: state.currentModel ?? undefined,
        durationMs: state.runStartedAt != null ? Date.now() - state.runStartedAt : undefined,
      },
    ],
    streamingText: null,
  };
}

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

    case 'text_delta': {
      // 助手开始说话 → 破坏连续只读组（延迟冻结 flush），再累加 streamingText
      const s = flushIfNeeded(state);
      return { ...s, streamingText: (s.streamingText ?? '') + event.text };
    }

    case 'tool_call_start': {
      // 本轮 text 结束（开始干活）→ 先把 streamingText 落地 + 清空，防 #2 跨轮累加。
      const flushed = flushStreamingText(state);
      return {
        ...state,
        completedMessages: flushed.completedMessages,
        streamingText: flushed.streamingText,
        activeTools: [...state.activeTools, { id: event.id, name: event.name, startedAt: Date.now(), input: event.input }],
      };
    }

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
      // 延迟冻结：只读工具 → 挂起 pendingReadSearch（不进 Static，动态区实时显示合并摘要）；
      // 非只读 → 先 flush 挂起组（它破坏了连续只读），再把这个工具进 Static。
      if (isReadSearchTool(event.name, msg.input)) {
        return { ...state, activeTools, pendingReadSearch: [...state.pendingReadSearch, msg] };
      }
      const s = flushIfNeeded(state);
      return { ...s, activeTools, completedMessages: [...s.completedMessages, msg] };
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
      const s = flushIfNeeded(state);
      // streamingText 落地复用 flushStreamingText（与 tool_call_start 同源，#2）
      const flushed = flushStreamingText(s);
      return {
        ...s,
        completedMessages: flushed.completedMessages,
        streamingText: flushed.streamingText,
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
        latestInputTokens: event.inputTokens, // per-call 覆写，供 Ctx% 计算
      };

    case 'warning': {
      const s = flushIfNeeded(state);
      return {
        ...s,
        completedMessages: [...s.completedMessages, { kind: 'warning', id: nextId(), text: event.message }],
      };
    }

    case 'error': {
      const s = flushIfNeeded(state);
      return {
        ...s,
        isRunning: false,
        error: event.error,
        completedMessages: [...s.completedMessages, { kind: 'error', id: nextId(), text: event.error }],
      };
    }

    default: {
      // exhaustive（noFallthroughCasesInSwitch + 类型守卫）
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

export { initialStreamState };
