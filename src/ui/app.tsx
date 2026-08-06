// App —— REPL 主体（spec §5.2 / §4.2 / §4.6 / §5.7）。
// 职责：组合子组件、斜杠命令 dispatch、首次 submit 同步清屏、双击 Ctrl+C 退出。
//
// 组合关系：
//   - 无 completedMessages 且未 submit 过 → WelcomeScreen；否则 ChatView
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
import { StatusBar, type StatusBarPhase } from './status-bar.js';
import { parseUserInput } from '../slash-commands.js';
import { getContextWindow, getDefaultModel } from '../providers/config.js';

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
  // 首次 submit 同步清屏（§5.2）：ref 控幂等，必须在 submit 函数体内同步执行，
  // 清掉 WelcomeScreen 残留行，让 ChatView 顶到首行。
  const hasClearedRef = useRef(false);

  // 默认 loadStatus：CLAUDE.md 不确定时给 null，provider 用 model 推断。
  const status: LoadStatus = loadStatus ?? {
    claudeMd: null,
    provider: { ok: true, label: model ?? 'default' },
  };

  // 全局按键（与 InputBar/PermissionDialog 的 useInput 并存；ink 按挂载序分发）：
  //   Esc → 中断当前流（权限弹窗期让位给 PermissionDialog 的 esc=deny）；
  //   Ctrl+C → 单击中断 / 双击退出。
  useInput((input, key) => {
    if (key.escape && api.isRunning && !api.pendingPermission) {
      api.abort();
      return;
    }
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
        process.exit(0);
      }
      lastCtrlCRef.current = now;
      if (api.isRunning) api.abort();
    }
  });

  const handleSubmit = (text: string) => {
    const parsed = parseUserInput(text);
    if (parsed.type === 'command') {
      handleCommand(parsed.name);
      return;
    }
    if (parsed.type === 'unknown_command') {
      // 未知斜杠命令：静默忽略（不送 LLM，不落地）
      return;
    }
    // 纯消息：首次 submit 同步清屏（清掉 WelcomeScreen 残留，§5.2）。
    // 仅在真实 TTY 清屏，避免污染测试/非交互 stdout。
    if (!hasClearedRef.current) {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[H');
      }
      hasClearedRef.current = true;
    }
    setStarted(true);
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
      case 'help':
      case 'cost':
      case 'compact':
      case 'resume':
      case 'sessions':
      case 'model':
        // M3.5 阶段②最小占位：暂无可注入系统消息的 hook 通道（useAgentStream 未暴露），
        // 这 6 个命令的可见响应留 Task 13 集成时补全：
        //   /cost 打印 usage 行；/model 需 App 级 model state + 重启 agent；
        //   /compact 需 agent core 暴露压缩入口 → 真正实现留 M4；
        //   /resume /sessions 复用 listSessions 打印。
        // 当前静默确认（已识别、不报错、不送 LLM），Task 13 验收如实标注。
        return;
      default:
        return;
    }
  };

  // StatusBar 阶段：permission > streaming > exit-window > idle。
  const phase: StatusBarPhase = api.pendingPermission
    ? 'permission'
    : api.isRunning
      ? 'streaming'
      : Date.now() - lastCtrlCRef.current < DOUBLE_CTRL_C_MS
        ? 'exit-window'
        : 'idle';

  return (
    <Box flexDirection="column">
      {!started ? (
        <WelcomeScreen version={version ?? APP_VERSION_FALLBACK} loadStatus={status} cwd={cwd} />
      ) : (
        <ChatView state={api} />
      )}

      {api.pendingPermission ? (
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
