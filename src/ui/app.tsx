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
import { PermissionDialog } from './permission-dialog.js';
import { SessionPicker } from './session-picker.js';
import { StatusBar, type StatusBarPhase } from './status-bar.js';
import { parseUserInput, SLASH_COMMANDS } from '../slash-commands.js';
import { getContextWindow, getDefaultModel } from '../providers/config.js';
import { listSessions, loadSession } from '../session.js';
import type { ECodeSessionSummary } from '../session.js';
import { messagesToDisplayMessages } from './messages-to-display.js';
import { shortSessionId } from './format-session.js';
import { sessionMessagesToTranscript } from './format-transcript.js';
import { runLess } from './pager.js';
import type { ResumeContext } from '../agent.js';

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
}

export function App({ model, cwd, loadStatus, system, version }: AppProps): React.ReactElement {
  const api = useAgentStream({ model, system });

  // 状态栏上下文百分比分母：用模型真实 contextWindow（config.json 可逐模型配置/覆盖），
  // 替代早期硬编码 60K——GLM 窗口 1M，硬编码会让百分比一眼顶到 99% 误报"超了"。
  const contextWindow = getContextWindow(model ?? getDefaultModel());

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
  // /resume 会话选择器（方向 C，详设 docs/20260806210000_历史会话切换-详设.md）：
  // resumeOpen 时 SessionPicker 替换 InputBar（Modal 三元前置）。sessions 已过滤当前会话。
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeSessions, setResumeSessions] = useState<ECodeSessionSummary[]>([]);
  // Ctrl+O 转录 pager（方向 B，详设 docs/20260806230000_工具折叠-详设.md §5.4/§5.5）：
  // inPager=true 时底部交互区卸载（消除 InputBar 等的 useInput 抢键）+ 全局 useInput 让位给 less。
  // ref 同步防重入/防按键串台（state 异步、ref 即时）；state 驱动渲染。
  const [inPager, setInPager] = useState(false);
  const inPagerRef = useRef(false);

  // 默认 loadStatus：CLAUDE.md 不确定时给 null，provider 用 model 推断。
  const status: LoadStatus = loadStatus ?? {
    claudeMd: null,
    provider: { ok: true, label: model ?? 'default' },
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
  //   Ctrl+O → 转录 pager（方向 B）；Esc → 中断当前流（专职软中断）；Ctrl+C → 双击退出（专职硬退出，单击仅进退出窗口）。
  //   pager 期间（inPagerRef）全部让位给 less（less inherit stdio 独占按键）。
  useInput((input, key) => {
    if (inPagerRef.current) return; // pager 期间让位
    if (key.ctrl && input === 'o') {
      void openPager();
      return;
    }
    if (key.escape && api.isRunning && !api.pendingPermission && !resumeOpen) {
      api.abort();
      return;
    }
    if (key.ctrl && input === 'c') {
      // Ctrl+C = 硬退出（专职）：双击(2s 内) process.exit；单击只记退出窗口（StatusBar 提示「再按退出」）。
      // 不再 abort——中断专职交给 Esc（横向分工，详设 docs/20260807000318）。
      const now = Date.now();
      if (now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
        process.exit(0);
      }
      lastCtrlCRef.current = now;
      setLastCtrlC(now); // 触发重绘 → phase 重算进 exit-window（StatusBar 提示「再按退出」）
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
      handleCommand(parsed.name);
      return;
    }
    api.submit(parsed.text);
  };

  // 斜杠命令分发（§5.1：UI 拦截命令，不送 LLM）。
  const handleCommand = (name: string) => {
    switch (name) {
      case 'clear':
        api.clear();
        return;
      case 'exit':
        // 走 process.exit（ink 的 useApp.exit 在测试/某些环境不触进程退出）。
        process.exit(0);
        return;
      case 'help': {
        const lines = SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
        api.addMessage({ kind: 'warning', id: `sys-help-${Date.now()}`, text: `可用命令:\n${lines.join('\n')}` });
        return;
      }
      case 'cost': {
        const { inputTokens, outputTokens } = api.usage;
        api.addMessage({
          kind: 'warning',
          id: `sys-cost-${Date.now()}`,
          text: `Token 用量: ${inputTokens.toLocaleString()} 输入 / ${outputTokens.toLocaleString()} 输出 (${(inputTokens + outputTokens).toLocaleString()} 总计)`,
        });
        return;
      }
      case 'sessions': {
        const sessions: ECodeSessionSummary[] = listSessions();
        if (sessions.length === 0) {
          api.addMessage({ kind: 'warning', id: `sys-sessions-${Date.now()}`, text: '暂无历史会话。' });
        } else {
          const lines = sessions.slice(0, 10).map(
            (s, i) => `${i + 1}. ${s.task.slice(0, 40)} (${s.model}, ${s.stats.rounds}轮) · ${shortSessionId(s.id)}`,
          );
          const footer = sessions.length > 10 ? `\n...共 ${sessions.length} 个会话(显示前 10)` : `\n共 ${sessions.length} 个会话`;
          api.addMessage({ kind: 'warning', id: `sys-sessions-${Date.now()}`, text: `历史会话:\n${lines.join('\n')}${footer}` });
        }
        return;
      }
      case 'resume': {
        // 过滤当前会话（对齐 CC filterResumableSessions：当前 session 不在列表，其文件不动）。
        const currentId = api.currentSessionId();
        const sessions = listSessions().filter((s) => s.id !== currentId);
        if (sessions.length === 0) {
          api.addMessage({ kind: 'warning', id: `sys-resume-${Date.now()}`, text: '暂无历史会话。' });
          return;
        }
        setResumeSessions(sessions);
        setResumeOpen(true);
        return;
      }
      case 'compact':
      case 'model':
        api.addMessage({
          kind: 'warning',
          id: `sys-todo-${Date.now()}`,
          text: `/${name} 命令尚未实现，将在后续版本补全。`,
        });
        return;
      default:
        return;
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

      {inPager ? null : resumeOpen ? (
        <SessionPicker
          sessions={resumeSessions}
          onConfirm={handleResumeConfirm}
          onCancel={() => setResumeOpen(false)}
        />
      ) : api.pendingPermission ? (
        <PermissionDialog
          permission={api.pendingPermission}
          onResolve={api.resolvePermission}
        />
      ) : (
        <InputBar onSubmit={handleSubmit} disabled={api.isRunning} />
      )}

      <StatusBar
        usage={api.usage}
        model={model ?? 'default'}
        provider={model ?? 'default'}
        ctxPercent={Math.min(99, Math.round((api.usage.inputTokens / contextWindow) * 100))}
        phase={phase}
        startedAt={startedAt}
      />
    </Box>
  );
}
