// UI 层显示用类型（spec §5.1：DisplayMessage ≠ LLM history）。
// 这些类型只服务于渲染层；LLM history 仍由 agent core 自己累加管理，
// 严禁从 DisplayMessage[] 反向重建 LLM messages。

import type { BusyState } from './agent-loop-controller.js';

/** 单条工具调用在动态区的运行态表示。 */
export interface ActiveTool {
  id: string;
  name: string;
  /** 启动时间戳（ms），供计时显示。 */
  startedAt: number;
  /** 工具输入参数（§9.5 透传，供动态区 ToolRunning / 历史区 BlockTool 摘要）。 */
  input?: Record<string, unknown>;
}

/** 已冻结进 <Static> 的消息（用户输入 / 助手文本 / 工具结果 / 系统警告）。 */
export type DisplayMessage =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      text: string; // 已完成的助手文本（completed 时从 streamingText 落地）
      model?: string; // 产出该回复的模型（MetaLine 数据源，M3.5 Phase 1）
      durationMs?: number; // 本轮回复耗时（MetaLine 数据源）
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      content: string;
      isError: boolean;
      input?: Record<string, unknown>;
    }
  | {
      // 折叠组：连续只读工具合并成的单条冻结消息（延迟冻结，详见
      // docs/详设/20260806220000_折叠组延迟冻结-详设.md）。Ctrl+O pager 展开 tools 看完整内容。
      kind: 'tool_group';
      id: string;
      tools: { name: string; content: string; isError: boolean; input?: Record<string, unknown> }[];
    }
  | { kind: 'warning'; id: string; text: string }
  | { kind: 'error'; id: string; text: string };

/** 权限请求挂起态（UI 据此渲染 PermissionDialog）。 */
export interface PendingPermission {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** reducer 的状态形状（不含命令方法；命令在 hook 层）。 */
export interface StreamState {
  completedMessages: DisplayMessage[];
  streamingText: string | null;
  activeTools: ActiveTool[];
  pendingPermission: PendingPermission | null;
  /** 累计 token（每轮 usage 事件累加，供 ↑↓ 费用显示）。 */
  usage: { inputTokens: number; outputTokens: number };
  /** 最近一次 API 调用的 inputTokens（per-call 覆写，供 Ctx% 计算）。
   *  区别于 usage.inputTokens（累计）：Ctx% 反映当前上下文占用，不是历史总和。 */
  latestInputTokens: number;
  isRunning: boolean;
  error: string | null;
  /** 最近一次 completed 的元信息（供状态栏/调试）。 */
  lastCompleted: { rounds: number; reason: string } | null;
  /** 当前模型名（start 事件记录，assistant MetaLine 数据源）。null = 尚未 start。 */
  currentModel: string | null;
  /** 本次 run 起始时间戳（start 事件记录，算 assistant 回复耗时）。null = 尚未 start。 */
  runStartedAt: number | null;
  /** <Static> 重置键：switchSession/clear 时 ++ → ChatView <Static key> 变 → 重 mount 重灌历史
   *  （<Static> append-only，切换/清空替换 completedMessages 后须 key 变才重渲染，否则只追加新项）。 */
  staticKey: number;
  /** 延迟冻结：挂起的连续只读工具（未 flush 进 Static，动态区实时显示折叠摘要）。
   *  组被破坏(text_delta/非只读 tool/completed/warning/error)时合并成 tool_group flush。
   *  详见 docs/详设/20260806220000_折叠组延迟冻结-详设.md。 */
  pendingReadSearch: DisplayMessage[];
  /** 调度状态机镜像（controller 真相源）：idle/running/compacting。isRunning/isCompacting 据此派生。 */
  busy: BusyState;
  /** 待处理队列镜像（排队灰显预览数据源，= controller.pendingQueue）。 */
  queuedMessages: string[];
  /** 待处理条数（StatusBar "待处理:N"）。 */
  pendingCount: number;
}

export const initialStreamState: StreamState = {
  completedMessages: [],
  streamingText: null,
  activeTools: [],
  pendingPermission: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  latestInputTokens: 0,
  isRunning: false,
  error: null,
  lastCompleted: null,
  currentModel: null,
  runStartedAt: null,
  staticKey: 0,
  pendingReadSearch: [],
  busy: 'idle',
  queuedMessages: [],
  pendingCount: 0,
};
