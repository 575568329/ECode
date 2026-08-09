// useAgentStream —— runAgentStream ↔ React state 的桥（消息队列与交互重做方案 §3）。
//
// 重构（v2）：调度逻辑下沉到 AgentLoopController（pendingQueue/runLoop/busyRef 状态机/compact 互斥），
// hook 只做 controller ↔ React state 桥接：
//   - onEvent       → reduceAgentEvent（reducer，streaming/tools/permission/completed→UI）
//   - onQueueChange → queuedMessages + pendingCount（排队灰显预览 + StatusBar 计数）
//   - onUserTurn    → 落正式 user 气泡（出队时，避免与 queuedMessages 双显，§4.2）
//   - onBusyChange  → busy（派生 isRunning/isCompacting，整体忙碌不随单轮 start/completed 抖动）
//   - onMessagesReset → compact 后重灌 completedMessages + staticKey++
//
// 设计要点：
//   - controller 用 useRef 持守（整个会话复用一次；clear/resetSession 只重置内部 refs 不重建实例）
//   - model/system 经 ref 透传给 controller 的 getRunOpts/getCompactOpts（/model 切换即时生效）
//   - reducer 的 state.isRunning 保留（start/completed 设，reducer 单测覆盖）；但 hook return 的
//     isRunning 改由 busy 派生（整体，不抖动），不再用 reducer 那份。
import { useCallback, useEffect, useRef, useState } from 'react';
import { runAgentStream, compactMessages } from '../agent.js';
import type { ResumeContext } from '../agent.js';
import { AllowList } from '../permission.js';
import type { GateDecision, GateResult, PermissionMode, Rule } from '../permission/types.js';
import type { HookDef } from '../hooks/types.js';
import { reduceAgentEvent, initialStreamState } from './reduce-agent-event.js';
import { AgentLoopController } from './agent-loop-controller.js';
import type { StreamState, DisplayMessage, PendingPermission } from './types.js';
import type { AgentEvent } from '../agent-events.js';
import { getDefaultModel } from '../providers/config.js';
import { messagesToDisplayMessages } from './messages-to-display.js';
import { extractTodos, type TodoItem } from '../tools/todo.js';
import type { ToolDefinition } from '../tools/types.js';
import { McpManager, type McpServerState } from '../mcp/manager.js';
import { loadMcpRegistry, saveMcpRegistry, type McpRegistryEntry } from '../mcp/registry.js';
import { adaptMcpPrompt } from '../mcp/adapter.js';
import { registerCommand, unregisterCommand } from '../slash-commands.js';

/** MCP 管理 API（/mcp 子命令用；封装 registry 读写 + manager 操作，app.tsx 只 dispatch）。 */
export interface McpApi {
  /** 列出所有 server 运行时状态（含 tools/lastError/entry；/mcp list/info/tools 显示源）。 */
  list: () => McpServerState[];
  /** 重连（断旧含进程清理 → 重建；/mcp reconnect）。 */
  reconnect: (name: string) => Promise<McpServerState>;
  /** 新增/覆盖 server（写 registry append/replace + connect；/mcp add fast-path）。 */
  add: (entry: McpRegistryEntry) => Promise<McpServerState>;
  /** 移除 server（disconnect + 写 registry 删 + forget；/mcp remove）。 */
  remove: (name: string) => Promise<void>;
  /** 启用/禁用（写 registry toggle + connect 按 enabled 走 connected/disabled；/mcp enable|disable）。 */
  enable: (name: string, on: boolean) => Promise<void>;
}

export interface UseAgentStreamReturn {
  completedMessages: DisplayMessage[];
  /** <Static> 重置键（switchSession/clear/compact ++）；ChatView 用作 <Static key> 强制重灌历史。 */
  staticKey: number;
  streamingText: string | null;
  activeTools: StreamState['activeTools'];
  /** 延迟冻结：挂起的连续只读工具（动态区实时显示合并摘要，组破坏时 flush 进 Static）。 */
  pendingReadSearch: DisplayMessage[];
  pendingPermission: PendingPermission | null;
  usage: StreamState['usage'];
  /** 最近一次 API 调用的 inputTokens（per-call，供 Ctx% 计算）。 */
  latestInputTokens: number;
  /** 整体忙碌（runLoop 在跑或 compacting）；派生自 controller busy，不随单轮 start/completed 抖动。 */
  isRunning: boolean;
  /** 压缩中（/compact 执行期间）。 */
  isCompacting: boolean;
  error: string | null;
  /** 排队预览（待处理 user 文本，灰显；= controller.pendingQueue 镜像）。 */
  queuedMessages: string[];
  /** 待处理条数（StatusBar "待处理:N"）。 */
  pendingCount: number;
  /** 任务清单（UI 派生自 todo_write，常驻面板渲染；空数组=无 todo）。 */
  todos: TodoItem[];
  /** 中断撤回回填文本（情况 A，配 draftVersion 用）。 */
  draftText: string;
  /** 中断撤回回填信号（递增触发 InputBar useEffect 回填）。 */
  draftVersion: number;
  /** submit 用户输入（命令在 App 层拦截，这里只处理纯消息 → 入 controller 队列）。 */
  submit: (text: string) => void;
  /** 用户在 PermissionDialog 选了决策。allow_always → allow.add(toolName) 后 resolve allow。
   *  feedback（可选，仅 deny）：作为 user 反馈回喂 LLM（阶段5b reject 反馈框）。 */
  resolvePermission: (decision: 'allow' | 'deny' | 'allow_always', feedback?: string) => void;
  /** 中断当前流（Ctrl+C 触发；controller.abort，runLoop 继续 drain queue，非抢占）。 */
  abort: () => void;
  /** 查某工具是否已 allow_always（测试 + 状态栏可用）。 */
  isAllowAlways: (toolName: string) => boolean;
  /** 当前权限档（default/acceptEdits/bypass），StatusBar 显示用。 */
  permissionMode: PermissionMode;
  /** Shift+Tab 循环切换权限档（下轮 submit 生效）。 */
  cyclePermissionMode: () => void;
  /** 清空已完成消息（/clear 命令用）。 */
  clear: () => void;
  /** 注入系统消息到聊天（/help /cost /sessions 等命令输出用，不送 LLM）。 */
  addMessage: (msg: DisplayMessage) => void;
  /** 切换到指定会话：重置续接上下文（controller）+ 用历史还原渲染态（/resume 载入用）。 */
  switchSession: (resume: ResumeContext, history: DisplayMessage[]) => void;
  /** 手动触发上下文压缩（/compact 命令用，D2）。返回前后消息数；null = 无会话/熔断/已排队。 */
  compact: () => Promise<{ before: number; after: number } | null>;
  /** 当前会话 id（controller.sessionRef）；null = 新会话未建立。/resume 过滤当前会话用。 */
  currentSessionId: () => string | null;
  /** MCP 管理 API（/mcp list/info/tools/reconnect/enable/disable/add/remove 用）。 */
  mcp: McpApi;
}

export interface UseAgentStreamOptions {
  model?: string;
  /** 预拼 system（含 CLAUDE.md）。 */
  system?: string;
  /** 初始权限档（CLI flag / settings.defaultMode 注入；Shift+Tab 运行时可改）。 */
  permissionMode?: PermissionMode;
  /** settings.json 加载的 deny 规则（启动一次，整会话静态）。 */
  denyRules?: Rule[];
  /** settings.json 加载的 hooks 配置（启动一次，整会话静态）。 */
  hooks?: HookDef[];
}

export function useAgentStream(opts: UseAgentStreamOptions = {}): UseAgentStreamReturn {
  const [state, setState] = useState<StreamState>(initialStreamState);
  const allowRef = useRef(new AllowList());
  // 权限 gate 决策 resolver（permission_request 时挂起，resolvePermission 时兑现）。
  // 阶段5b：resolver 兑现 GateResult——无反馈时纯 GateDecision 字符串，有反馈时 { decision, feedback }。
  const permissionResolverRef = useRef<((r: GateResult) => void) | null>(null);

  // model/system 经 ref 透传给 controller（/model 切换即时生效；controller 仅创建一次，闭包会固化首值，故走 ref）
  const modelRef = useRef(opts.model);
  modelRef.current = opts.model;
  const systemRef = useRef(opts.system);
  systemRef.current = opts.system;
  // 权限档：state 驱动 StatusBar 显示；ref 供 getRunOpts 闭包即时读（Shift+Tab 改 ref+state，下轮 submit 生效）。
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(opts.permissionMode ?? 'default');
  const permissionModeRef = useRef<PermissionMode>(opts.permissionMode ?? 'default');
  permissionModeRef.current = permissionMode;
  // denyRules 启动一次、整会话静态（来自 settings.json），用 ref 透传给 getRunOpts。
  const denyRulesRef = useRef<Rule[] | undefined>(opts.denyRules);
  denyRulesRef.current = opts.denyRules;
  // hooks 启动一次、整会话静态（来自 settings.json），用 ref 透传给 getRunOpts。
  const hooksRef = useRef<HookDef[] | undefined>(opts.hooks);
  hooksRef.current = opts.hooks;
  // 中断撤回回填信号（情况 A）：draftVersion 递增 → InputBar useEffect 回填 draftText 到输入框。
  // hook 内部持（不透传 App），用 controlled prop 替代 ref（forwardRef 在 React 19+ink7 破坏 useInput）。
  const [draft, setDraft] = useState<{ text: string; version: number }>({ text: '', version: 0 });

  // MCP server（改线 McpManager：连接池 + 互斥锁 + onChange 重注册）。
  // manager 用 ref 持守（整会话一次）；tools 经 ref 喂 getRunOpts，prompts 注册斜杠命令。
  const mcpManagerRef = useRef<McpManager | null>(null);
  if (mcpManagerRef.current === null) {
    mcpManagerRef.current = new McpManager();
  }
  const mcpToolsRef = useRef<ToolDefinition[]>([]);
  const mcpCmdNamesRef = useRef<string[]>([]); // 已注册 MCP 斜杠命令名（重注册前先注销旧的）
  useEffect(() => {
    const manager = mcpManagerRef.current!;
    let cancelled = false;

    // MCP prompt 消息 → 文本（作为 user 消息注入 agent）
    const messagesToText = (messages: unknown): string =>
      (messages as Array<{ role?: string; content?: unknown }>)
        .map((m) => {
          const content = m.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
          }
          return String(content ?? '');
        })
        .join('\n');

    // 同步 prompts 为斜杠命令（先注销旧的，再按当前 pool 注册）
    const syncPrompts = () => {
      for (const name of mcpCmdNamesRef.current) {
        unregisterCommand(name);
      }
      const cmdNames: string[] = [];
      for (const { serverName, prompt } of manager.getAllPrompts()) {
        const cmd = adaptMcpPrompt(
          serverName,
          prompt,
          (name, args) => manager.callPrompt(serverName, name, args),
          (messages) => {
            const text = messagesToText(messages);
            if (text.trim()) controllerRef.current?.submit(text);
          },
        );
        registerCommand(cmd);
        cmdNames.push(cmd.name);
      }
      mcpCmdNamesRef.current = cmdNames;
      if (cmdNames.length > 0) {
        console.log(`[MCP] 已注册 ${cmdNames.length} 个 prompt 斜杠命令`);
      }
    };

    // tools 同步（getRunOpts 闭包读 ref）
    const syncTools = () => {
      mcpToolsRef.current = manager.getAllTools();
    };

    // 终态变更 → 重同步（manager 仅终态 emit，防 prompts 抖动）
    const off = manager.onChange(() => {
      syncTools();
      syncPrompts();
    });

    // 启动连接（connectAll 内每个 server 连上即 emit → onChange 同步；完成后再同步一次兜底）
    void manager.connectAll().then(() => {
      if (cancelled) return;
      syncTools();
      syncPrompts();
    });

    return () => {
      cancelled = true;
      off();
      for (const name of mcpCmdNamesRef.current) {
        unregisterCommand(name);
      }
      mcpCmdNamesRef.current = [];
      void manager.disconnectAll();
    };
  }, []);

  // apply = 事件分发。todo_write 单独拦截（§6）：从 input.todos 派生 state.todos，不进 reducer
  // （避免 activeTools 残留 todo_write + completedMessages 多一条 tool 行）。其余事件走 reducer。
  const apply = useCallback((event: AgentEvent) => {
    if ((event.type === 'tool_call_start' || event.type === 'tool_result') && event.name === 'todo_write') {
      const todos = extractTodos(event.input);
      if (todos) setState((prev) => ({ ...prev, todos }));
      return; // 不进 reducer
    }
    setState((prev) => reduceAgentEvent(prev, event));
  }, []);

  // controller：useRef 持守，整个会话创建一次。callbacks 桥接 controller → React state。
  // apply/setState 稳定，callbacks 闭包固化无碍；model/system 走 ref 不固化。
  const controllerRef = useRef<AgentLoopController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new AgentLoopController({
      runAgent: runAgentStream,
      compactMessages,
      getRunOpts: () => ({
        model: modelRef.current,
        system: systemRef.current,
        allow: allowRef.current,
        permissionMode: permissionModeRef.current,
        getPermissionMode: () => permissionModeRef.current, // Shift+Tab 运行中切换即时生效（每工具 check 读最新）
        denyRules: denyRulesRef.current,
        hooks: hooksRef.current,
        // MCP 工具合并（阶段3：加载完成前 ref 为空，加载后追加到内置工具后面）
        tools: mcpToolsRef.current.length > 0
          ? [...mcpToolsRef.current]
          : undefined,
        permissionGate: {
          ask: () =>
            new Promise<GateResult>((resolve) => {
              permissionResolverRef.current = resolve;
            }),
        },
      }),
      getCompactOpts: () => ({
        model: modelRef.current ?? getDefaultModel(),
        system: systemRef.current ?? '',
      }),
      callbacks: {
        onEvent: apply,
        onQueueChange: (q) =>
          setState((prev) => ({ ...prev, queuedMessages: [...q], pendingCount: q.length })),
        // 出队的 user 落正式气泡（与 queuedMessages 不双显：submit 入 queued，出队移出 + 进 completed）
        onUserTurn: (text) =>
          setState((prev) => ({
            ...prev,
            completedMessages: [
              ...prev.completedMessages,
              { kind: 'user', id: `u${Date.now()}`, text },
            ],
          })),
        // busy 驱动 isRunning/isCompacting（整体，不随单轮 start/completed 抖动）
        onBusyChange: (busy) => setState((prev) => ({ ...prev, busy })),
        // compact 后用压缩 messages 重灌 completedMessages + staticKey++（仿 switchSession 重置渲染态）
        onMessagesReset: (messages) =>
          setState((prev) => ({
            ...prev,
            completedMessages: messagesToDisplayMessages(messages),
            streamingText: null,
            activeTools: [],
            pendingReadSearch: [],
            staticKey: prev.staticKey + 1,
          })),
        // 中断分情况 A（未回应）→ 移最后 user 气泡 + 递增 draftVersion 回填输入框（不显示中断标记）
        onTurnReverted: (text) => {
          setState((prev) => {
            // 从末尾移除最后一条 user 气泡（本轮 onUserTurn 落的），让界面像「没发过」
            const msgs = [...prev.completedMessages];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].kind === 'user') {
                msgs.splice(i, 1);
                break;
              }
            }
            return { ...prev, completedMessages: msgs };
          });
          setDraft((prev) => ({ text, version: prev.version + 1 }));
        },
        // 中断分情况 B（已回应）→ 显示「— 已中断 —」（替代旧 app.tsx 同步 addMessage：同步瞬间无法区分 A/B）
        onTurnAborted: () =>
          setState((prev) => ({
            ...prev,
            completedMessages: [
              ...prev.completedMessages,
              { kind: 'warning', id: `sys-abort-${Date.now()}`, text: '— 已中断 —' },
            ],
          })),
      },
    });
  }
  const controller = controllerRef.current;

  const submit = useCallback(
    (text: string) => {
      controller.submit(text);
    },
    [controller],
  );

  const resolvePermission = useCallback(
    (decision: 'allow' | 'deny' | 'allow_always', feedback?: string) => {
      // 🔴-2 修复：透传三态给核心层；allow_always 的 add 由 agent.ts 处理（收到 allow_always 即 add）。
      // UI 不再 add，避免双写。AllowList 是同一实例（allowRef → opts.allow），核心层 add 即生效。
      // UI 'allow'（本次放行，Yes）→ 核心 'allow_once'；allow_always/deny 直传。
      // 阶段5b：deny 携带 feedback 时 resolve 对象形式（agent.ts 拼进 denied 回喂 LLM）；
      //   无 feedback 时 resolve 纯 GateDecision 字符串（向后兼容现有 mock/测试）。
      const coreDecision: GateDecision = decision === 'allow' ? 'allow_once' : decision;
      const gate: GateResult =
        decision === 'deny' && feedback ? { decision: coreDecision, feedback } : coreDecision;
      permissionResolverRef.current?.(gate);
      permissionResolverRef.current = null;
      setState((prev) => ({ ...prev, pendingPermission: null }));
    },
    [],
  );

  const abort = useCallback(() => {
    controller.abort();
  }, [controller]);

  const isAllowAlways = useCallback((toolName: string) => allowRef.current.has(toolName), []);

  // Shift+Tab 循环权限档：default → acceptEdits → bypass → default（仿 CC getNextPermissionMode）。
  // 改 state（驱动 StatusBar 重绘）+ 同步 ref（下轮 submit 的 getRunOpts 即时读新档）。
  const cyclePermissionMode = useCallback(() => {
    const NEXT: Record<PermissionMode, PermissionMode> = {
      default: 'acceptEdits',
      acceptEdits: 'bypass',
      bypass: 'default',
    };
    setPermissionMode((prev) => {
      const next = NEXT[prev];
      permissionModeRef.current = next;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    // controller 重置真相源（session/messages/queue）+ onQueueChange([])；UI 彻底重置对齐 switchSession：
    // usage/latestInputTokens 归零（/cost 不串台）+ streamingText/activeTools/pendingReadSearch/todos/error 清空。
    controller.clear();
    setState((prev) => ({
      ...prev,
      completedMessages: [],
      streamingText: null,
      activeTools: [],
      pendingReadSearch: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      latestInputTokens: 0,
      todos: [],
      error: null,
      staticKey: prev.staticKey + 1,
    }));
  }, [controller]);

  const addMessage = useCallback((msg: DisplayMessage) => {
    setState((prev) => ({ ...prev, completedMessages: [...prev.completedMessages, msg] }));
  }, []);

  // /resume 载入：controller 载入真相源（resetSession）+ 用历史软重置渲染态。
  // 对齐 clear 的「重置 + completedMessages」模式；usage 归零（新会话视角，/cost 不串台）。
  // staticKey++ → <Static> 重 mount 重灌历史（append-only 否则只追加新项，旧 index 位不刷新）。
  const switchSession = useCallback(
    (resume: ResumeContext, history: DisplayMessage[]) => {
      controller.resetSession(resume);
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
    },
    [controller],
  );

  // /compact 手动触发（D2）：委托 controller。onMessagesReset 回调已处理重灌 + staticKey++，
  // 这里只把 {before,after}/null 透传给 app.tsx 的命令分支做文案反馈。
  const compact = useCallback(() => controller.compact(), [controller]);

  const currentSessionId = useCallback(() => controller.currentSessionId(), [controller]);

  // MCP 管理 API（/mcp 子命令用；registry 读写 + manager 操作封装于此，app.tsx 不直接碰 registry）。
  const mcp: McpApi = {
    list: () => mcpManagerRef.current!.getStatus() as McpServerState[],
    reconnect: (name) => mcpManagerRef.current!.reconnect(name),
    add: async (entry) => {
      const entries = loadMcpRegistry();
      const exists = entries.some((e) => e.name === entry.name);
      saveMcpRegistry(exists ? entries.map((e) => (e.name === entry.name ? entry : e)) : [...entries, entry]);
      return mcpManagerRef.current!.connect(entry.name, entry);
    },
    remove: async (name) => {
      await mcpManagerRef.current!.disconnect(name);
      saveMcpRegistry(loadMcpRegistry().filter((e) => e.name !== name));
      mcpManagerRef.current!.forget(name);
    },
    enable: async (name, on) => {
      saveMcpRegistry(loadMcpRegistry().map((e) => (e.name === name ? { ...e, enabled: on } : e)));
      // connect 重读 registry，connectOne 按新 enabled 走 connected / disabled
      await mcpManagerRef.current!.connect(name);
    },
  };

  return {
    completedMessages: state.completedMessages,
    staticKey: state.staticKey,
    streamingText: state.streamingText,
    activeTools: state.activeTools,
    pendingReadSearch: state.pendingReadSearch,
    pendingPermission: state.pendingPermission,
    usage: state.usage,
    latestInputTokens: state.latestInputTokens,
    isRunning: state.busy !== 'idle',
    isCompacting: state.busy === 'compacting',
    error: state.error,
    queuedMessages: state.queuedMessages,
    pendingCount: state.pendingCount,
    todos: state.todos,
    draftText: draft.text,
    draftVersion: draft.version,
    submit,
    resolvePermission,
    abort,
    isAllowAlways,
    permissionMode,
    cyclePermissionMode,
    clear,
    addMessage,
    switchSession,
    compact,
    currentSessionId,
    mcp,
  };
}
