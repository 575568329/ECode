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
import { loadSkills } from '../skills/loader.js';
import { getSkillBody } from '../skills/matcher.js';
import { getContextWindow, getDefaultModel, getModelConfig, listAvailableModels } from '../providers/config.js';
import { computeCost } from '../providers/cost.js';
import type { ModelCost, ImageSource } from '../providers/types.js';
import { maskSecret, type McpRegistryEntry } from '../mcp/registry.js';
import type { McpServerState } from '../mcp/manager.js';
import { shutdown } from '../lifecycle.js';
import { listSessions, loadSession } from '../session.js';
import type { ECodeSessionSummary } from '../session.js';
import { messagesToDisplayMessages } from './messages-to-display.js';
import { shortSessionId } from './format-session.js';
import { sessionMessagesToTranscript } from './format-transcript.js';
import { runLess } from './pager.js';
import { createProvider } from '../providers/factory.js';
import { generateProposals, MAX_PENDING } from '../skill-capture/generator.js';
import { loadProposals, acceptProposal, rejectProposal, promoteProposal, type ProposalRecord } from '../skill-capture/proposal.js';
import { SkillDialog, type SkillAction } from './skill-dialog.js';
import type { ResumeContext } from '../agent.js';
import type { PermissionMode, Rule } from '../permission/types.js';
import type { HookDef } from '../hooks/types.js';

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
  /** settings.json 加载的 hooks 配置（启动一次，整会话静态）。 */
  hooks?: HookDef[];
}

export function App({ model, cwd, loadStatus, system, version, permissionMode, denyRules, hooks }: AppProps): React.ReactElement {
  // currentModel：可变 model state（/model 切换 → 下一轮 submit 用新 model）。model prop 是初始值。
  const [currentModel, setCurrentModel] = useState(model);
  // currentModel 的 ref 镜像：斜杠命令 handler（ref-guard 只注册一次）需读最新 model，
  // 直接闭包捕获 currentModel 会固化首值；handler 内统一走 currentModelRef.current（如 /skill-gen 归纳用模型）。
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  // /model 选择器（D1，照搬 SessionPicker）：modelOpen 时 ModelPicker 替换 InputBar。
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<PickerItem[]>([]);
  const api = useAgentStream({
    model: currentModel,
    system,
    permissionMode,
    denyRules,
    hooks,
  });

  // 状态栏上下文百分比分母：用模型真实 contextWindow（config.json 可逐模型配置/覆盖），
  // 替代早期硬编码 60K——GLM 窗口 1M，硬编码会让百分比一眼顶到 99% 误报"超了"。
  const contextWindow = getContextWindow(currentModel ?? getDefaultModel());
  // 当前模型单价（$/M token）；订阅制/未配 cost → undefined（StatusBar 显示 $--）。
  // 命令 handler 只注册一次（ref-guard），闭包会 stale，故额外用 ref 让 /cost 读到最新单价。
  let modelCost: ModelCost | undefined;
  // currentProvider：StatusBar 显示真实 provider 名（旧代码误传 model 名）。与 modelCost 同源 getModelConfig 一次取。
  let currentProvider = 'default';
  if (currentModel) {
    try {
      const resolution = getModelConfig(currentModel);
      modelCost = resolution.config.cost;
      currentProvider = resolution.providerKey;
    } catch {
      modelCost = undefined; // 未知模型不计费（防御，正常 currentModel 来自 listAvailableModels）
      // currentProvider 保持 'default'
    }
  }
  const modelCostRef = useRef(modelCost);
  modelCostRef.current = modelCost;

  // started：用户是否已 submit 过（含被命令清空后——清空不回退到欢迎屏）。
  const [started, setStarted] = useState(false);
  const [startedAt] = useState(Date.now());
  const lastCtrlCRef = useRef(0);
  // lastCtrlC state：Ctrl+C 单击同步更新 → 触发重绘让 StatusBar phase 重算进 exit-window
  // （ref 变化不触发重绘，旧代码靠 abort 的 setState 顺带重绘，删 abort 后须显式驱动）。
  // ref 保留做双击即时判断（state 异步，双击两次事件间未必 commit，双击须即时）。
  const [lastCtrlC, setLastCtrlC] = useState(0);
  // /resume 会话选择器（方向 C，详设 docs/详设/20260806210000_历史会话切换-详设.md）：
  // resumeOpen 时 SessionPicker 替换 InputBar（Modal 三元前置）。sessions 已过滤当前会话。
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeSessions, setResumeSessions] = useState<ECodeSessionSummary[]>([]);
  // skillProposals 非 null → SkillDialog 替换 InputBar（/skill 无参 + 有 pending 时开启；§16）。
  const [skillProposals, setSkillProposals] = useState<ProposalRecord[] | null>(null);
  // Ctrl+O 转录 pager（方向 B，详设 docs/详设/20260806213000_工具折叠-详设[已完成].md §5.4/§5.5）：
  // inPager=true 时底部交互区卸载（消除 InputBar 等的 useInput 抢键）+ 全局 useInput 让位给 less。
  // ref 同步防重入/防按键串台（state 异步、ref 即时）；state 驱动渲染。
  const [inPager, setInPager] = useState(false);
  const inPagerRef = useRef(false);
  // exit-window 自动消失：Ctrl+C 单击进退出窗口后，起 timer 到期清零 → 强制重绘让 phase 退回。
  // 🔴 不可省：exit-window 靠 Date.now()-lastCtrlC 时间戳比较派生，2s 窗口过期后若无 setState 触发
  //   重绘，提示 `press ctrl+c again to exit` 永久常驻（尤其中断 agent 后无事件流、React 不重绘时）。
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        void shutdown(0); // 双击 → 清理 MCP 子进程 + 退出（debugging #019）
      }
      lastCtrlCRef.current = now;
      setLastCtrlC(now); // 单击进退出窗口（StatusBar 提示「再按 ctrl+c 退出」）
      // 窗口到期主动清零 → 强制重绘让 phase 重算退出 exit-window。否则 agent 静止（无事件流）时
      // React 不重绘，时间戳比较派生的 exit-window 永久常驻（提示不消失）。双击退出走 process.exit，无需清。
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        setLastCtrlC(0);
      }, DOUBLE_CTRL_C_MS);
      if (api.isRunning) {
        api.abort(); // 单击：streaming 时中断对话
        // 中断标记不再同步 addMessage——改由 controller completed 后按 A/B 分情况驱动（同步瞬间
        // 无法知道 LLM 回没回）：
        //   情况 A（本轮 LLM 未回应）→ onTurnReverted：回填输入框 + 移 user 气泡 + 不显示中断
        //   情况 B（本轮 LLM 已回应）→ onTurnAborted：显示「— 已中断 —」（hook 内部 addMessage）
      }
    }
  });

  const handleSubmit = (text: string, images?: ImageSource[]) => {
    const parsed = parseUserInput(text);
    if (parsed.type === 'unknown_command') {
      // 未知斜杠命令：静默忽略（不送 LLM，不落地）
      return;
    }
    // 推进到 ChatView（started=true）。不再清屏——\x1b[2J\x1b[H 会清空终端 scrollback buffer，
    // 导致右侧滚动条消失、无法向上翻看历史。WelcomeScreen 的残留会留在 scrollback 顶部（无害）。
    const isExit = parsed.type === 'command' && parsed.name === 'exit';
    if (!isExit) setStarted(true);

    if (parsed.type === 'command') {
      // 命令 dispatch 异步（/compact 内部 await api.compact()）；fire-and-forget 不阻塞 submit。
      void handleCommand(parsed.name, parsed.args);
      return;
    }
    api.submit(parsed.text, images);
  };

  // ---- skill 审批操作（命令式 /skill accept/reject/promote 与 SkillDialog 共用）----
  // 纯 IO + 反馈，不刷新列表（调用方按需刷新：dialog 操作后 reload，命令式时 dialog 未开）。
  const skillId = () => `sys-skill-${Date.now()}`;
  const doSkillOp = (op: SkillAction, name: string, force: boolean): void => {
    if (op === 'accept') {
      const res = acceptProposal(name);
      if (res.ok) api.addMessage({ kind: 'warning', id: skillId(), text: `✓ ${name} 已落盘（项目级 .ecode/skills/），下次会话生效。` });
      else if (res.reason === 'critical') api.addMessage({ kind: 'warning', id: skillId(), text: `⛔ ${name} 检测到 critical 风险，已 quarantine，不可 apply。` });
      else api.addMessage({ kind: 'warning', id: skillId(), text: `未找到提案 ${name}（/skill-gen 生成后再审）。` });
    } else if (op === 'promote') {
      const res = promoteProposal(name, { force });
      if (res.ok) api.addMessage({ kind: 'warning', id: skillId(), text: `✓ ${name} 已提升到用户级（跨项目复用）。` });
      else if (res.reason === 'exists') api.addMessage({ kind: 'warning', id: skillId(), text: `⏭ 用户级已存在 ${name}，跳过（/skill promote ${name} --force 覆盖）。` });
      else if (res.reason === 'critical') api.addMessage({ kind: 'warning', id: skillId(), text: `⛔ ${name} 检测到 critical 风险，拒绝 promote。` });
      else api.addMessage({ kind: 'warning', id: skillId(), text: `未找到提案 ${name}（/skill-gen 生成后再审）。` });
    } else if (op === 'reject') {
      const res = rejectProposal(name);
      api.addMessage({ kind: 'warning', id: skillId(), text: res.ok ? `✗ 已删除提案 ${name}。` : `未找到提案 ${name}。` });
    }
  };
  // SkillDialog 的操作回调：执行 + 刷新提案列表（accept/reject 删记录；空则关 dialog）。
  const handleSkillAction = (action: SkillAction, record: ProposalRecord): void => {
    doSkillOp(action, record.name, false);
    const refreshed = loadProposals();
    setSkillProposals(refreshed.length > 0 ? refreshed : null);
  };

  // 斜杠命令分发（§5.1：UI 拦截命令，不送 LLM）。
  // 阶段 3 MCP 前置：内置命令 handler 注册（ref-guard 只注册一次，闭包捕获 UI 状态）。
  const handlersRegistered = useRef(false);
  if (!handlersRegistered.current) {
    handlersRegistered.current = true;
    registerCommandHandler('clear', () => api.clear());
    registerCommandHandler('exit', () => void shutdown(0));
    registerCommandHandler('help', () => {
      const lines = SLASH_COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
      api.addMessage({ kind: 'warning', id: `sys-help-${Date.now()}`, text: `可用命令:\n${lines.join('\n')}` });
    });
    registerCommandHandler('cost', () => {
      const u = api.usage;
      const total = u.inputTokens + u.outputTokens;
      const lines = [
        `Token 用量：输入 ${u.inputTokens.toLocaleString()} · 输出 ${u.outputTokens.toLocaleString()} · 总计 ${total.toLocaleString()}`,
      ];
      if (u.cacheReadTokens) lines.push(`  缓存命中 ${u.cacheReadTokens.toLocaleString()}（按折扣价计费）`);
      if (u.cacheWriteTokens) lines.push(`  缓存写入 ${u.cacheWriteTokens.toLocaleString()}`);
      if (u.reasoningTokens) lines.push(`  推理 ${u.reasoningTokens.toLocaleString()}（含于输出）`);
      const mc = modelCostRef.current; // ref 读最新（避免 handler 闭包 stale）
      if (mc) lines.push(`费用：$${computeCost(u, mc).toFixed(4)}`);
      api.addMessage({ kind: 'warning', id: `sys-cost-${Date.now()}`, text: lines.join('\n') });
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
    registerCommandHandler('skill', (args) => {
      const id = () => `sys-skill-${Date.now()}`;
      const sub = args[0];

      // 子命令：accept/reject/promote <name> [--force]（命令式审批，§5；非交互场景或快速操作）
      if (sub === 'accept' || sub === 'reject' || sub === 'promote') {
        const name = args[1];
        if (!name) {
          api.addMessage({ kind: 'warning', id: id(), text: `用法: /skill ${sub} <name>${sub === 'promote' ? ' [--force]' : ''}` });
          return;
        }
        doSkillOp(sub, name, args.includes('--force'));
        return;
      }

      // 无参：pending 提案 >0 → 开审批 picker（§16.2）；否则列已安装技能（向后兼容浏览）
      if (!sub) {
        const pending = loadProposals();
        if (pending.length > 0) {
          setSkillProposals(pending);
          return;
        }
        const skills = loadSkills();
        if (skills.length === 0) {
          api.addMessage({ kind: 'warning', id: id(), text: '暂无待审批提案，也无已安装技能。用 /skill-gen 从观察记录归纳生成提案。' });
          return;
        }
        const lines = skills.map((s) => `  /skill ${s.name.padEnd(12)} ${s.description}`);
        api.addMessage({ kind: 'warning', id: id(), text: `暂无待审批提案。已安装技能:\n${lines.join('\n')}\n（用 /skill-gen 从观察记录归纳生成提案）` });
        return;
      }

      // /skill <name>：apply 已安装技能（原行为；skill 正文送 LLM 执行）
      const skills = loadSkills();
      const body = getSkillBody(sub, skills);
      if (!body) {
        api.addMessage({ kind: 'warning', id: id(), text: `未找到技能 "${sub}"。可用：${skills.map((s) => s.name).join(', ')}（或 /skill 进审批 picker）` });
        return;
      }
      api.submit(body);
    });
    registerCommandHandler('mcp', async (args) => {
      const sub = args[0];
      const id = () => `sys-mcp-${Date.now()}`;
      const mcp = api.mcp;

      // /mcp add <name> <command> [args...] —— stdio fast-path
      if (sub === 'add') {
        const name = args[1];
        const command = args[2];
        const cmdArgs = args.slice(3);
        if (!name || !command) {
          api.addMessage({ kind: 'warning', id: id(), text: '用法: /mcp add <name> <command> [args...]\n示例: /mcp add github npx -y @modelcontextprotocol/server-github' });
          return;
        }
        const entry: McpRegistryEntry = {
          name, transport: 'stdio', command,
          args: cmdArgs.length > 0 ? cmdArgs : undefined,
          enabled: true,
        };
        const st = await mcp.add(entry);
        api.addMessage({
          kind: 'warning', id: id(),
          text: st.status === 'connected'
            ? `已添加并连接 ${name}（${st.tools.length} 个工具）`
            : `已添加 ${name}，连接失败：${st.lastError ?? '未知原因'}`,
        });
        return;
      }

      // /mcp remove <name>
      if (sub === 'remove') {
        const name = args[1];
        if (!name) { api.addMessage({ kind: 'warning', id: id(), text: '用法: /mcp remove <name>' }); return; }
        await mcp.remove(name);
        api.addMessage({ kind: 'warning', id: id(), text: `已移除 ${name}` });
        return;
      }

      // /mcp reconnect <name>（断旧含进程清理 → 重建）
      if (sub === 'reconnect') {
        const name = args[1];
        if (!name) { api.addMessage({ kind: 'warning', id: id(), text: '用法: /mcp reconnect <name>' }); return; }
        const st = await mcp.reconnect(name);
        api.addMessage({
          kind: 'warning', id: id(),
          text: st.status === 'connected'
            ? `已重连 ${name}（${st.tools.length} 个工具）`
            : `重连 ${name} 失败：${st.lastError ?? '未知原因'}`,
        });
        return;
      }

      // /mcp enable|disable <name>
      if (sub === 'enable' || sub === 'disable') {
        const name = args[1];
        if (!name) { api.addMessage({ kind: 'warning', id: id(), text: `用法: /mcp ${sub} <name>` }); return; }
        await mcp.enable(name, sub === 'enable');
        api.addMessage({ kind: 'warning', id: id(), text: `已${sub === 'enable' ? '启用' : '禁用'} ${name}` });
        return;
      }

      // /mcp info <name> —— 详情（transport/command/url/lastError/工具数）
      if (sub === 'info') {
        const name = args[1];
        if (!name) { api.addMessage({ kind: 'warning', id: id(), text: '用法: /mcp info <name>' }); return; }
        const st = mcp.list().find((s) => s.name === name);
        if (!st) { api.addMessage({ kind: 'warning', id: id(), text: `未找到 server "${name}"` }); return; }
        const e = st.entry;
        const lines = [
          `${name}  [${st.status}]`,
          `  传输: ${st.transport}`,
          e.description ? `  描述: ${e.description}` : null,
          e.command ? `  命令: ${e.command}${e.args && e.args.length ? ' ' + e.args.join(' ') : ''}` : null,
          e.url ? `  URL: ${e.url}` : null,
          e.env && Object.keys(e.env).length > 0
            ? `  环境变量: ${Object.entries(e.env).map(([k, v]) => `${k}=${maskSecret(v)}`).join(', ')}`
            : null,
          st.lastError ? `  最近错误: ${st.lastError}` : null,
          `  工具数: ${st.tools.length}`,
        ].filter((l): l is string => l !== null);
        api.addMessage({ kind: 'warning', id: id(), text: lines.join('\n') });
        return;
      }

      // /mcp tools <name> —— 列出工具
      if (sub === 'tools') {
        const name = args[1];
        if (!name) { api.addMessage({ kind: 'warning', id: id(), text: '用法: /mcp tools <name>' }); return; }
        const st = mcp.list().find((s) => s.name === name);
        if (!st) { api.addMessage({ kind: 'warning', id: id(), text: `未找到 server "${name}"` }); return; }
        if (st.tools.length === 0) {
          api.addMessage({ kind: 'warning', id: id(), text: `${name} 暂无工具（状态: ${st.status}）` });
          return;
        }
        const lines = st.tools.map((t) => `  ${t.name}${t.description ? '  ' + t.description.slice(0, 60) : ''}`);
        api.addMessage({ kind: 'warning', id: id(), text: `${name} 工具（${st.tools.length}）:\n${lines.join('\n')}` });
        return;
      }

      // 默认 / /mcp list —— 列出所有 server（真实连接状态，非 enabled 开关）
      const states = mcp.list();
      if (states.length === 0) {
        api.addMessage({ kind: 'warning', id: id(), text: '无 MCP server。添加: /mcp add <name> <command> [args...]' });
        return;
      }
      const icon = (s: McpServerState['status']): string =>
        s === 'connected' ? '✓' : s === 'failed' ? '✗' : s === 'disabled' ? '−' : '○';
      const lines = states.map((s) => {
        const target = s.entry.command ?? s.entry.url ?? '(无)';
        const err = s.lastError ? `  ⚠ ${s.lastError}` : '';
        return `  ${icon(s.status)} ${s.name.padEnd(16)} ${s.transport.padEnd(6)} ${target}${err}`;
      });
      api.addMessage({
        kind: 'warning', id: id(),
        text: `MCP servers:\n${lines.join('\n')}\n子命令: /mcp info|tools|reconnect|enable|disable|add|remove <name>`,
      });
    });

    // /skill-gen —— 读 .ecode/observations.jsonl，LLM Ratchet 归纳生成技能提案（§4）。
    // provider/model 用当前会话模型（currentModelRef 读最新值，避免闭包固化）；无 API key → 降级提示。
    // generateProposals 内部已对单批 LLM 失败 / 单候选解析失败静默降级（§15），此处只兜顶层异常。
    registerCommandHandler('skill-gen', async () => {
      const id = () => `sys-skill-gen-${Date.now()}`;
      const model = currentModelRef.current ?? getDefaultModel();
      let provider;
      try {
        provider = createProvider(model);
      } catch (e) {
        api.addMessage({ kind: 'warning', id: id(), text: `归纳失败：无法为模型 ${model} 创建 provider（${(e as Error).message}）。` });
        return;
      }
      api.addMessage({ kind: 'warning', id: id(), text: `正在用 ${model} 归纳观察记录…` });
      try {
        const result = await generateProposals({ provider, model });
        if (result.batches === 0) {
          api.addMessage({ kind: 'warning', id: id(), text: '暂无观察记录可归纳。多表达「下次/记住/总是」等意图会自动记录（见 .ecode/observations.jsonl）。' });
          return;
        }
        const critical = result.proposals.filter((p) => p.scan.hasCritical).length;
        const safeText = critical > 0 ? `${critical} 个含严重安全告警` : '均通过安全扫描';
        const baseText = result.proposals.length === 0
          ? `读了 ${result.totalObservations} 条记录（${result.batches} 批），但 LLM 判定素材不足，未产出提案（继续记录后会重试）。`
          : `已生成 ${result.proposals.length} 个技能提案（${result.batches} 批，${safeText}）。用 /skill 审批（accept / reject / promote）。`;
        // §4 限额：pending 达 MAX_PENDING → 提示先审批（FIFO 已在 generator 截断最老，避免无限堆积）
        const limitHint = result.pendingAfter >= MAX_PENDING
          ? `\n⚠️ 待审批已达上限 ${MAX_PENDING}，已自动裁剪最旧的提案。建议先 /skill 审批后再归纳。`
          : '';
        api.addMessage({ kind: 'warning', id: id(), text: baseText + limitHint });
      } catch (e) {
        api.addMessage({ kind: 'warning', id: id(), text: `归纳过程异常：${(e as Error).message}` });
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
    // 不清屏——\x1b[2J\x1b[H 会清空 scrollback buffer 导致滚动条消失。
    // staticKey++ 驱动 <Static> 重 mount（在 use-agent-stream switchSession 内处理）。
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
      ) : skillProposals ? (
        <SkillDialog
          proposals={skillProposals}
          onAction={handleSkillAction}
          onClose={() => setSkillProposals(null)}
        />
      ) : api.pendingPermission ? (
        <PermissionDialog
          permission={api.pendingPermission}
          onResolve={api.resolvePermission}
        />
      ) : (
        <InputBar draftText={api.draftText} draftVersion={api.draftVersion} onSubmit={handleSubmit} />
      )}

      <StatusBar
        usage={api.usage}
        model={currentModel ?? 'default'}
        provider={currentProvider}
        ctxPercent={Math.min(99, Math.round((api.latestInputTokens / contextWindow) * 100))}
        phase={phase}
        startedAt={startedAt}
        pendingCount={api.pendingCount}
        permissionMode={api.permissionMode}
        cost={modelCost}
      />
    </Box>
  );
}
