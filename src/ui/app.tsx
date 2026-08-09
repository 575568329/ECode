// App —— REPL 主体（spec §5.2 / §4.2 / §4.6 / §5.7）。
// 职责：组合子组件、斜杠命令 dispatch、首次 submit 同步清屏、双击 Ctrl+C 退出。
//
// 组合关系：
//   - 无 completedMessages 且未 submit 过 → WelcomeScreen；否则 ChatView
//   - resumeOpen → SessionPicker（/resume 会话选择，方向 C；Modal 替换 InputBar）
//   - pendingPermission 挂起 → PermissionDialog（Modal 替换 InputBar，唯一活跃 useInput）
//   - StatusBar 恒显底部
import React, { useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { useAgentStream } from './use-agent-stream.js';
import { WelcomeScreen } from './welcome-screen.js';
import type { LoadStatus } from './welcome-screen.js';
import { ChatView } from './chat-view.js';
import { InputBar } from './input-bar.js';
import { QueuedMessages } from './queued-messages.js';
import { TodoPanel } from './todo-panel.js';
import { PermissionDialog } from './permission-dialog.js';
import { SessionPicker } from './session-picker.js';
import { ModelPicker } from './model-picker.js';
import type { PickerItem } from './picker-list.js';
import { StatusBar, type StatusBarPhase } from './status-bar.js';
import { parseUserInput, SLASH_COMMANDS, registerCommandHandler, findCommandHandler } from '../slash-commands.js';
import { getContextWindow, getDefaultModel, listAvailableModels } from '../providers/config.js';
import { listSessions, loadSession } from '../session.js';
import type { ECodeSessionSummary } from '../session.js';
import { messagesToDisplayMessages } from './messages-to-display.js';
import { shortSessionId } from './format-session.js';
import { sessionMessagesToTranscript } from './format-transcript.js';
import { runLess } from './pager.js';
import type { ResumeContext } from '../agent.js';
import type { PermissionMode, Rule } from '../permission/types.js';

/** 双击 Ctrl+C 退出窗口（ms）：窗口内第二次 Ctrl+C → process.exit。 */
const DOUBLE_CTRL_C_MS = 2000;
/**
 * REPL 欢迎屏版本号兜底值（与 package.json 保持一致）。
 * 生产入口（src/index.ts）会从 package.json 读取真实版本经 `version` prop 注入，
 * 此常量仅用于未注入时（如单测）的回退，避免 UI 空字段。
 */
const APP_VERSION_FALLBACK = '0.1.0';

interface AppProps {
  model?: string;
  cwd: string;
  /** 注入：测试用；生产由 index.ts 传 loadInstructions/buildSystemPrompt 结果。 */
  loadStatus?: LoadStatus;
  system?: string;
  /** REPL 欢迎屏版本号；缺省时回退到 APP_VERSION_FALLBACK。由 index.ts 读 package.json 注入。 */
  version?: string;
  /** 初始权限档（CLI flag / settings.defaultMode 推导，由 index.ts 注入；Shift+Tab 运行时可改）。 */
  permissionMode?: PermissionMode;
  /** settings.json 加载的 deny 规则（启动一次，整会话静态）。 */
  denyRules?: Rule[];
}

export function App({ model, cwd, loadStatus, system, version, permissionMode, denyRules }: AppProps): React.ReactElement {
  // currentModel：可变 model state（/model 切换 → 下一轮 submit 用新 model）。model prop 是初始值。
  const [currentModel, setCurrentModel] = useState(model);
  // /model 选择器（D1，照搬 SessionPicker）：modelOpen 时 ModelPicker 替换 InputBar。
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<PickerItem[]>([]);
  const api = useAgentStream({ model: currentModel, system, permissionMode, denyRules });

  // 状态栏上下文百分比分母：用模型真实 contextWindow（config.json 可逐模型配置/覆盖），
  // 替代早期硬编码 60K——GLM 窗口 1M，硬编码会让百分比一眼顶到 99% 误报"超了"。
  const contextWindow = getContextWindow(currentModel ?? getDefaultModel());

  // started：用户是否已 submit 过（含被命令清空后——清空不回退到欢迎屏）。
  const [started, setStarted] = useState(false);
  const [startedAt] = useState(Date.now());
  const lastCtrlCRef = useRef(0);
  // lastCtrlC state：Ctrl+C 单击同步更新 → 触发重绘让 StatusBar phase 重算进 exit-window
  // （ref 变化不触发重绘，旧代码靠 abort 的 setState 顺带重绘，删 abort 后须显式驱动）。
  // ref 保留做双击即时判断（state 异步，双击两次事件间未必 commit，双击须即时）。
  const [lastCtrlC, setLastCtrlC] = useState(0);
  // 首次 submit 同步清屏（§5.2）：ref 控幂等，必须在 submit 函数体内同步执行，
  // 清掉 WelcomeScreen 残留行，让 ChatView 顶到首行。
  const hasClearedRef = useRef(false);
  // /resume 会话选择器（方向 C，详设 docs/详设/20260806210000_历史会话切换-详设.md）：
  // resumeOpen 时 SessionPicker 替换 InputBar（Modal 三元前置）。sessions 已过滤当前会话。
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeSessions, setResumeSessions] = useState<ECodeSessionSummary[]>([]);
  // Ctrl+O 转录 pager（方向 B，详设 docs/详设/20260806213000_工具折叠-详设[已完成].md §5.4/§5.5）：
  // inPager=true 时底部交互区卸载（消除 InputBar 等的 useInput 抢键）+ 全局 useInput 让位给 less。
  // ref 同步防重入/防按键串台（state 异步、ref 即时）；state 驱动渲染。
  const [inPager, setInPager] = useState(false);
  const inPagerRef = useRef(false);

  // 默认 loadStatus：CLAUDE.md 不确定时给 null，provider 用 model 推断。
  const status: LoadStatus = loadStatus ?? {
    claudeMd: null,
    provider: { ok: true, label: currentModel ?? 'default' },
  };

  // Ctrl+O → 进转录 pager 看完整会话（整段 completedMessages → less 全屏）。
  // 空 → 提示不进；非空 → alternate screen + less，try/finally 兜底确保切回主屏（绝不卡 alternate）。
  const openPager = async () => {
    if (inPagerRef.current) return; // 防重入
    const transcript = sessionMessagesToTranscript(api.completedMessages);
    if (transcript.length === 0) {
      api.addMessage({ kind: 'warning', id: `sys-pager-${Date.now()}`, text: '暂无内容可查看。' });
      return;
    }
    inPagerRef.current = true;
    setInPager(true);
    // 等 ink 重绘落地（InputBar 卸载）再进 alternate buffer：setInPager 是异步 state，
    // 同步紧跟 1049h 会让 alternate 快照保存「含旧 ❯ 的主屏」，退出恢复后与重绘的新 ❯
    // 叠加 → 双 ❯（问题 C）。让出一帧让 React 提交 + ink 重绘，快照即不含 ❯。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    process.stdout.write('\x1b[?1049h'); // 切 alternate buffer
    try {
      await runLess(transcript);
    } catch (err) {
      api.addMessage({
        kind: 'error',
        id: `sys-pager-err-${Date.now()}`,
        text: `无法打开转录视图（需安装 less）: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      process.stdout.write('\x1b[?1049l'); // 切回主 buffer
      inPagerRef.current = false;
      setInPager(false);
    }
  };

  // 全局按键（与 InputBar/PermissionDialog/SessionPicker 的 useInput 并存；ink 按挂载序分发）：
  //   Ctrl+O → 转录 pager（方向 B）；Ctrl+C → 单击中断对话（streaming→abort）/ 双击(2s 内) process.exit 退出。
  //   Esc 不在此全局接——弹窗内由各 modal 自身 useInput 接（picker/permission/session），
  //   主区 Esc 双击(500ms)清空输入框由 InputBar 接；两路都不中断对话（中断归 Ctrl+C）。
  //   pager 期间（inPagerRef）全部让位给 less（less inherit stdio 独占按键）。
  useInput((input, key) => {
    if (inPagerRef.current) return; // pager 期间让位
    if (key.ctrl && input === 'o') {
      void openPager();
      return;
    }
    // Shift+Tab：循环权限档 default → acceptEdits → bypass → default（仿 CC Shift+Tab）。
    // 仅在非弹窗态切换（pendingPermission/各 picker 打开时不抢键）；下一轮 submit 生效。
    if (key.tab && key.shift && !api.pendingPermission && !resumeOpen && !modelOpen) {
      api.cyclePermissionMode();
      return;
    }
    // Ctrl+C（详设 docs/详设/20260807000318，2026-08-07 反转）：单击中断对话（streaming→abort），
    // 双击(2s 内) 关闭对话（process.exit）。中断+退出都归 Ctrl+C；Esc 只退出弹窗+清空输入框。
    // Esc 不再在此处理——弹窗内 Esc 由各 modal 组件自身 useInput 接（picker/permission/session），
    // 主区 Esc 双击清空由 InputBar 接；故 App 全局对 Esc 无操作。
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
        process.exit(0); // 双击 → 关闭对话
      }
      lastCtrlCRef.current = now;
      setLastCtrlC(now); // 单击进退出窗口（StatusBar 提示「再按 ctrl+c 退出」）
      if (api.isRunning) {
        api.abort(); // 单击：streaming 时中断对话
        // §3.5 中断 warning（纯 UI）：addMessage 只改 completedMessages，不进 controller messagesRef，
        // 对抗「中断后零反馈、不知为何停」的困惑。用户重 submit 即新一轮。
        api.addMessage({ kind: 'warning', id: `sys-abort-${Date.now()}`, text: '— 已中断 —' });
      }
    }
  });

  const handleSubmit = (text: string) => {
    const parsed = parseUserInput(text);
    if (parsed.type === 'unknown_command') {
      // 未知斜杠命令：静默忽略（不送 LLM，不落地）
      return;
    }
    // 首次 submit 同步清屏（清掉 WelcomeScreen 残留，§5.2）+ 推进到 ChatView。
    // 斜杠命令（除 /exit 立即退出）同样需要：否则欢迎屏期间 ChatView 未挂载，
    // /help /cost /sessions 等 addMessage 输出无处渲染 → 用户看到「命令没效果」。
    // 仅在真实 TTY 清屏，避免污染测试/非交互 stdout。
    const isExit = parsed.type === 'command' && parsed.name === 'exit';
    if (!isExit && !hasClearedRef.current) {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[H');
      }
      hasClearedRef.current = true;
    }
    if (!isExit) setStarted(true);

    if (parsed.type === 'command') {
      // 命令 dispatch 异步（/compact 内部 await api.compact()）；fire-and-forget 不阻塞 submit。
      void handleCommand(parsed.name, parsed.args);
      return;
    }
    api.submit(parsed.text);
  };

  // 斜杠命令分发（§5.1：UI 拦截命令，不送 LLM）。
  // 阶段 3 MCP 前置：内置命令 handler 注册（ref-guard 只注册一次，闭包捕获 UI 状态）。
  const handlersRegistered = useRef(false);
  if (!handlersRegistered.current) {
    handlersRegistered.current = true;
    registerCommandHandler('clear', () => api.clear());
    registerCommandHandler('exit', () => process.exit(0));
    registerCommandHandler('help', () => {
      const lines = SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
      api.addMessage({ kind: 'warning', id: `sys-help-${Date.now()}`, text: `可用命令:\n${lines.join('\n')}` });
    });
    registerCommandHandler('cost', () => {
      const { inputTokens, outputTokens } = api.usage;
      api.addMessage({ kind: 'warning', id: `sys-cost-${Date.now()}`, text: `Token 用量: ${inputTokens.toLocaleString()} 输入 / ${outputTokens.toLocaleString()} 输出 (${(inputTokens + outputTokens).toLocaleString()} 总计)` });
    });
    registerCommandHandler('sessions', () => {
      const sessions: ECodeSessionSummary[] = listSessions();
      if (sessions.length === 0) {
        api.addMessage({ kind: 'warning', id: `sys-sessions-${Date.now()}`, text: '暂无历史会话。' });
        return;
      }
      const lines = sessions.slice(0, 10).map(
        (s, i) => `${i + 1}. ${s.task.slice(0, 40)} (${s.model}, ${s.stats.rounds}轮) · ${shortSessionId(s.id)}`,
      );
      const footer = sessions.length > 10 ? `\n...共 ${sessions.length} 个会话(显示前 10)` : `\n共 ${sessions.length} 个会话`;
      api.addMessage({ kind: 'warning', id: `sys-sessions-${Date.now()}`, text: `历史会话:\n${lines.join('\n')}${footer}` });
    });
    registerCommandHandler('resume', () => {
      const currentId = api.currentSessionId();
      const sessions = listSessions().filter((s) => s.id !== currentId);
      if (sessions.length === 0) {
        api.addMessage({ kind: 'warning', id: `sys-resume-${Date.now()}`, text: '暂无历史会话。' });
        return;
      }
      setResumeSessions(sessions);
      setResumeOpen(true);
    });
    registerCommandHandler('model', async (args) => {
      const direct = args[0];
      const available = listAvailableModels();
      if (direct) {
        const hit = available.find((m) => m.model === direct || m.model.startsWith(direct));
        if (hit) {
          setCurrentModel(hit.model);
          api.addMessage({ kind: 'warning', id: `sys-model-${Date.now()}`, text: `已切换到模型: ${hit.model}（${hit.provider}）` });
          return;
        }
        api.addMessage({ kind: 'warning', id: `sys-model-${Date.now()}`, text: `未找到模型 "${direct}"，请从列表选择：` });
      }
      const opts = available
        .filter((m) => m.model !== currentModel)
        .map((m) => ({ name: m.model, description: m.provider }));
      if (opts.length === 0) {
        api.addMessage({ kind: 'warning', id: `sys-model-${Date.now()}`, text: '没有其他可选模型。' });
        return;
      }
      setModelOptions(opts);
      setModelOpen(true);
    });
    registerCommandHandler('compact', async () => {
      api.addMessage({ kind: 'warning', id: `sys-compact-start-${Date.now()}`, text: '正在压缩上下文…' });
      const result = await api.compact();
      if (result === null) {
        api.addMessage({ kind: 'warning', id: `sys-compact-${Date.now()}`, text: '压缩未执行：无活跃会话，或已达压缩极限。' });
      } else {
        api.addMessage({ kind: 'warning', id: `sys-compact-${Date.now()}`, text: `已压缩上下文：${result.before} → ${result.after} 条消息。` });
      }
    });
  }

  // handleCommand：dispatch 查表（内置 + 动态/MCP 命令统一入口）。
  const handleCommand = async (name: string, args: string[]): Promise<void> => {
    const handler = findCommandHandler(name);
    if (handler) {
      // CommandContext.addMessage 用 rest unknown 绕类型依赖；Parameters<> 保证 dispatch 侧类型安全。
      const ctx: { addMessage: (...args: unknown[]) => void } = {
        addMessage: (...a: unknown[]) => api.addMessage(...(a as Parameters<typeof api.addMessage>)),
      };
      await handler(args, ctx);
    }
  };

  // /resume 选中会话 → 载入历史 + 软重置续接上下文（详设 §3.4：switchSession + 过滤当前会话不丢失）。
  const handleResumeConfirm = (id: string) => {
    // 真实终端清屏重画（<Static> append-only：切换会话须清掉旧消息；测试 !isTTY 不执行，不影响断言）。
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    const session = loadSession(id);
    const history = messagesToDisplayMessages(session.messages, session.model);
    const resume: ResumeContext = {
      id: session.id,
      task: session.task,
      createdAt: session.createdAt,
      messages: session.messages,
    };
    api.switchSession(resume, history);
    setResumeOpen(false);
    setStarted(true);
  };

  // StatusBar 阶段：permission > exit-window > streaming > idle。
  // exit-window 优先于 streaming：Ctrl+C 单击进退出窗口后，即便仍在 streaming 也要提示「再按退出」
  // （否则 streaming 态按 Ctrl+C 单击无可见反馈——StatusBar 仍只显示 esc to interrupt，用户不知再按即退出）。
  const phase: StatusBarPhase = api.pendingPermission
    ? 'permission'
    : Date.now() - lastCtrlC < DOUBLE_CTRL_C_MS
      ? 'exit-window'
      : api.isRunning
        ? 'streaming'
        : 'idle';

  return (
    <Box flexDirection="column">
      {!started ? (
        <WelcomeScreen version={version ?? APP_VERSION_FALLBACK} loadStatus={status} cwd={cwd} />
      ) : (
        <ChatView state={api} />
      )}

      <TodoPanel todos={api.todos} />
      <QueuedMessages messages={api.queuedMessages} />

      {inPager ? null : resumeOpen ? (
        <SessionPicker
          sessions={resumeSessions}
          onConfirm={handleResumeConfirm}
          onCancel={() => setResumeOpen(false)}
        />
      ) : modelOpen ? (
        <ModelPicker
          options={modelOptions}
          onConfirm={(modelName) => {
            setCurrentModel(modelName);
            setModelOpen(false);
            api.addMessage({ kind: 'warning', id: `sys-model-${Date.now()}`, text: `已切换到模型: ${modelName}` });
          }}
          onCancel={() => setModelOpen(false)}
        />
      ) : api.pendingPermission ? (
        <PermissionDialog
          permission={api.pendingPermission}
          onResolve={api.resolvePermission}
        />
      ) : (
        <InputBar onSubmit={handleSubmit} />
      )}

      <StatusBar
        usage={api.usage}
        model={currentModel ?? 'default'}
        provider={currentModel ?? 'default'}
        ctxPercent={Math.min(99, Math.round((api.latestInputTokens / contextWindow) * 100))}
        phase={phase}
        startedAt={startedAt}
        pendingCount={api.pendingCount}
        permissionMode={api.permissionMode}
      />
    </Box>
  );
}
