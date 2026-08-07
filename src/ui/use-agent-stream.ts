// useAgentStream —— runAgentStream ↔ React state 的桥（spec §5.1 / §4.3 / §4.4 / §4.5）。
// 设计：
//   - 核心状态转换委托纯函数 reduceAgentEvent（可单测）
//   - 双 state + ref：useState 驱动渲染，useRef 在 async 闭包内读最新值（§4.3）
//   - generation 计数器防竞态（§4.4）：abort A 后启 B，A 的 finally 不覆盖 B
//   - 权限 gate 内部把 allow_always 映射成 allow + allow.add（§4.5，agent core 无感）
import { useCallback, useRef, useState } from 'react';
import { runAgentStream } from '../agent.js';
import type { RunAgentStreamOptions, ResumeContext } from '../agent.js';
import { AllowList } from '../permission.js';
import { reduceAgentEvent, initialStreamState } from './reduce-agent-event.js';
import type { StreamState, DisplayMessage, PendingPermission } from './types.js';

export interface UseAgentStreamReturn {
  completedMessages: DisplayMessage[];
  /** <Static> 重置键（switchSession/clear ++）；ChatView 用作 <Static key> 强制重灌历史。 */
  staticKey: number;
  streamingText: string | null;
  activeTools: StreamState['activeTools'];
  /** 延迟冻结：挂起的连续只读工具（动态区实时显示合并摘要，组破坏时 flush 进 Static）。 */
  pendingReadSearch: DisplayMessage[];
  pendingPermission: PendingPermission | null;
  usage: StreamState['usage'];
  /** 最近一次 API 调用的 inputTokens（per-call，供 Ctx% 计算）。 */
  latestInputTokens: number;
  isRunning: boolean;
  error: string | null;
  /** submit 用户输入（含斜杠命令？不——命令在 App 层拦截，这里只处理纯消息）。 */
  submit: (text: string) => void;
  /** 用户在 PermissionDialog 选了决策。allow_always → allow.add(toolName) 后 resolve allow。 */
  resolvePermission: (decision: 'allow' | 'deny' | 'allow_always') => void;
  /** 中断当前流（Esc 触发）。 */
  abort: () => void;
  /** 查某工具是否已 allow_always（测试 + 状态栏可用）。 */
  isAllowAlways: (toolName: string) => boolean;
  /** 清空已完成消息（/clear 命令用）。 */
  clear: () => void;
  /** 注入系统消息到聊天（/help /cost /sessions 等命令输出用，不送 LLM）。 */
  addMessage: (msg: DisplayMessage) => void;
  /** 切换到指定会话：重置续接上下文（sessionRef）+ 用历史还原渲染态（/resume 载入用）。 */
  switchSession: (resume: ResumeContext, history: DisplayMessage[]) => void;
  /** 当前会话 id（sessionRef.current?.id）；null = 新会话未建立。/resume 过滤当前会话用。 */
  currentSessionId: () => string | null;
}

export interface UseAgentStreamOptions {
  model?: string;
  /** 预拼 system（含 CLAUDE.md）。 */
  system?: string;
}

export function useAgentStream(opts: UseAgentStreamOptions = {}): UseAgentStreamReturn {
  const [state, setState] = useState<StreamState>(initialStreamState);

  // refs（async 闘包内读最新值，§4.3）
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const allowRef = useRef(new AllowList());
  // 跨轮会话续接的真相源（修 REPL 每轮新会话 + 失忆）：首次为 null（新会话），
  // runAgentStream 的 completed 事件带回 {id,messages,...} 后存入此 ref；
  // 之后每次 submit 经 resumed 传回 → agent 复用同一会话（同 id 覆盖同一文件）。
  // /clear 重置为 null 开新会话。对齐 CCode sessionLogger.ensureSession 幂等 / Claude Code ref 持守。
  const sessionRef = useRef<ResumeContext | null>(null);

  // 权限 gate 决策 resolver（permission_request 时挂起，resolvePermission 时兑现）
  const permissionResolverRef = useRef<((d: 'allow' | 'deny') => void) | null>(null);

  const apply = useCallback((event: Parameters<typeof reduceAgentEvent>[1]) => {
    setState((prev) => reduceAgentEvent(prev, event));
  }, []);

  const submit = useCallback(
    (text: string) => {
      // 用户消息先落地（同步，UI 立刻可见）
      setState((prev) => ({
        ...prev,
        completedMessages: [...prev.completedMessages, { kind: 'user', id: `u${Date.now()}`, text }],
      }));

      const generation = ++generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      // gate 实现（§4.5）：ask 返回 Promise，由 resolvePermission 兑现
      const streamOpts: RunAgentStreamOptions = {
        model: opts.model,
        system: opts.system,
        signal: controller.signal,
        allow: allowRef.current,
        permissionGate: {
          ask: () =>
            new Promise<'allow' | 'deny'>((resolve) => {
              permissionResolverRef.current = resolve;
            }),
        },
        // 续接：首次 sessionRef 为 null → 不传 → agent 开新会话；
        // 之后传回上一轮 completed 带回的 {id,messages,...} → agent 复用同会话带历史。
        resumed: sessionRef.current ?? undefined,
      };

      // async IIFE：消费事件流（§5.1 submit 流程 4-11）
      void (async () => {
        try {
          for await (const event of runAgentStream(text, streamOpts)) {
            apply(event);
            // completed 带回本轮全量历史 + 会话元信息，存入 sessionRef 供下一轮 resumed 续接。
            if (event.type === 'completed') {
              sessionRef.current = {
                id: event.sessionId,
                task: event.task,
                createdAt: event.createdAt,
                messages: event.messages,
              };
            }
          }
        } catch (err) {
          // runAgentStream 内部已 try/yield error，这里兜底未捕获异常
          apply({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // generation 匹配才清 isRunning（§4.4 防竞态）
          if (generationRef.current === generation) {
            setState((prev) => (prev.isRunning ? { ...prev, isRunning: false } : prev));
          }
        }
      })();
    },
    [opts.model, opts.system, apply],
  );

  const resolvePermission = useCallback((decision: 'allow' | 'deny' | 'allow_always') => {
    if (decision === 'allow_always' && stateRef.current.pendingPermission) {
      allowRef.current.add(stateRef.current.pendingPermission.toolName);
    }
    permissionResolverRef.current?.(decision === 'deny' ? 'deny' : 'allow');
    permissionResolverRef.current = null;
    setState((prev) => ({ ...prev, pendingPermission: null }));
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const isAllowAlways = useCallback((toolName: string) => allowRef.current.has(toolName), []);

  const clear = useCallback(() => {
    // 清 UI 渲染态 + 重置会话续接真相源 → 下一次 submit 走新会话（新 id、新文件、不带旧历史）。
    // staticKey++ → <Static> 重 mount（append-only 不自动清空，须 key 变才重灌）。
    sessionRef.current = null;
    setState((prev) => ({ ...prev, completedMessages: [], pendingReadSearch: [], staticKey: prev.staticKey + 1 }));
  }, []);

  const addMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, completedMessages: [...prev.completedMessages, msg] }));
  }, []);

  // /resume 载入：把续接真相源换成目标会话（后续 submit 经 resumed 复用同会话）+ 用历史软重置渲染态。
  // 对齐 clear 的「重置 sessionRef + completedMessages」模式；usage 归零（新会话视角，/cost 不串台）。
  // staticKey++ → <Static> 重 mount 重灌历史（append-only 否则只追加新项，旧 index 位不刷新）。
  const switchSession = useCallback((resume: ResumeContext, history: DisplayMessage[]) => {
    sessionRef.current = resume;
    setState((prev) => ({
      ...prev,
      completedMessages: history,
      streamingText: null,
      activeTools: [],
      pendingReadSearch: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      latestInputTokens: 0,
      staticKey: prev.staticKey + 1,
    }));
  }, []);

  const currentSessionId = useCallback(() => sessionRef.current?.id ?? null, []);

  return {
    completedMessages: state.completedMessages,
    staticKey: state.staticKey,
    streamingText: state.streamingText,
    activeTools: state.activeTools,
    pendingReadSearch: state.pendingReadSearch,
    pendingPermission: state.pendingPermission,
    usage: state.usage,
    latestInputTokens: state.latestInputTokens,
    isRunning: state.isRunning,
    error: state.error,
    submit,
    resolvePermission,
    abort,
    isAllowAlways,
    clear,
    addMessage,
    switchSession,
    currentSessionId,
  };
}
