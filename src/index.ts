#!/usr/bin/env node

/**
 * ECode — 手写 AI coding agent
 *
 * 使用:
 *   ecode                             进入沉浸式 REPL（无参 + 交互终端 TTY）
 *   ecode --repl                      强制进入 REPL（即便非 TTY，自动化/测试用）
 *   ecode "<任务>"                    开始新会话(one-shot 逐字流式)
 *   ecode --continue                  恢复最近会话(打印摘要,不调 LLM)
 *   ecode -c "新指令"                 续接最近会话(--continue 简写)
 *   ecode --resume <id>               恢复指定会话(打印摘要,不调 LLM)
 *   ecode --resume <id> "新指令"      续接指定会话
 *   ecode --sessions                  列出本项目全部会话(不调 LLM)
 *   ecode --model <name> "<任务>"     指定模型
 *   ecode --list-models               列出可用模型
 *
 * 双模式入口（spec §八 阶段②验收）：
 *   - 无参 + TTY → REPL（沉浸式默认入口）；--repl 显式触发 → REPL
 *   - 有任务 → one-shot（保留 ecode "任务" 现状）
 *   - 无参 + 非 TTY（管道/CI）→ 打印用法退出（Ink 抢占无输入源 stdin 不安全）
 *
 * 会话历史落盘 .ecode/sessions/(已 gitignore)。
 * 模型配置见 ~/.ecode/config.json;API Key 通过环境变量传入,.env 由 npm run dev 自动加载。
 */

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { listAvailableModels } from './providers/config.js';
import { listSessions, loadSession, latestSessionId, SessionNotFoundError } from './session.js';
import type { ECodeSession } from './session.js';
import { loadInstructions } from './instructions-loader.js';
import { buildSystemPrompt } from './system-prompt.js';
import { selectEntryMode } from './repl-mode.js';
import { loadPermissionSettings } from './permission/settings-loader.js';
import type { PermissionMode, Rule } from './permission/types.js';
import type { HookDef } from './hooks/types.js';

/**
 * 组装 system prompt 的指令记忆（4 层回退）。
 *
 * 第 1 层 homedir() 是【用户级全局指令】（~/ECODE.md / ~/CLAUDE.md），非数据目录——
 * 不收口到 resolveDataDir()（~/.ecode 是配置/会话数据目录，语义不同）。跨 Windows/WSL
 * 混合环境的对端 home 自探测属 §9.3 增强，一期沿用 homedir()（与 resolveDataDir 一期
 * 行为一致），将来增强只改本函数一处。loadInstructions 本身是纯 IO，home/cwd 解析归此。
 */
function buildSystemInstructions(projectRoot: string): string {
  return loadInstructions([
    homedir(), // 用户级全局指令（~/ECODE.md 等）
    projectRoot, // 项目根指令
    resolve(projectRoot, '.ecode'), // 项目 .ecode 指令
    projectRoot, // cwd 与 root 同;保留以对齐 4 层模型
  ]);
}

const { values, positionals } = parseArgs({
  options: {
    model: { type: 'string' },
    'list-models': { type: 'boolean' },
    sessions: { type: 'boolean' },
    continue: { type: 'boolean', short: 'c' }, // -c 简写
    resume: { type: 'string' },
    repl: { type: 'boolean' }, // 强制 REPL 模式（即便非 TTY）
    // M4 阶段 4：权限档 CLI flag。
    'permission-mode': { type: 'string' }, // default | acceptEdits | bypass
    'dangerously-skip-permissions': { type: 'boolean' }, // = bypass（便捷别名，跳过全部审批）
  },
  allowPositionals: true,
});

/**
 * 推导初始权限档 + 加载 deny 规则（M4 阶段 4）。
 * 优先级：--dangerously-skip-permissions（=bypass）> --permission-mode > settings.defaultMode > default。
 * fatal：非法 mode 值直接退出（早暴露，避免静默回退 default 误导）。
 */
function resolvePermission(): { mode: PermissionMode; denyRules: Rule[]; hooks: HookDef[] } {
  const VALID: PermissionMode[] = ['default', 'acceptEdits', 'bypass'];
  if (values['dangerously-skip-permissions']) {
    return { mode: 'bypass', denyRules: [], hooks: [] }; // bypass 免疫 deny，无需加载
  }
  const cliMode = values['permission-mode'] as PermissionMode | undefined;
  if (cliMode !== undefined) {
    if (!VALID.includes(cliMode)) {
      fatal(`非法 --permission-mode 值 "${cliMode}"，可选：default | acceptEdits | bypass`);
    }
  }
  const settings = loadPermissionSettings({ initialMode: cliMode });
  return { mode: settings.mode, denyRules: settings.rules.filter((r) => r.action === 'deny'), hooks: settings.hooks };
}

// ============================================================
// 工具函数
// ============================================================

/** ISO → 本地可读 "YYYY-MM-DD HH:mm:ss"。 */
function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

/** 提取最后一条 assistant 的文本(纯恢复摘要预览用)。无则返回空串。 */
function lastAssistantText(session: ECodeSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    const textBlock = msg.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') return textBlock.text;
  }
  return '';
}

/** 统一的致命错误出口。 */
function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

/** 打印用法。 */
function printUsage(): void {
  console.error('用法: ecode [选项] <任务描述>\n');
  console.error('  ecode                             进入沉浸式 REPL(交互终端)');
  console.error('  ecode --repl                      强制进入 REPL');
  console.error('  ecode "<任务>"                    开始新会话');
  console.error('  ecode --continue                  恢复最近会话(不调 LLM)');
  console.error('  ecode -c "新指令"                 续接最近会话');
  console.error('  ecode --resume <id>               恢复指定会话(不调 LLM)');
  console.error('  ecode --resume <id> "新指令"      续接指定会话');
  console.error('  ecode --sessions                  列出全部会话');
  console.error('  ecode --model <name> "<任务>"     指定模型');
  console.error('  ecode --list-models               列出可用模型');
  console.error('  ecode --permission-mode <mode>    权限档: default|acceptEdits|bypass');
  console.error('  ecode --dangerously-skip-permissions  跳过全部审批 (=bypass)');
}

/**
 * 读 package.json 的版本号（REPL 欢迎屏显示用）。
 *
 * 路径相对本文件解析（dev: src/index.ts / prod: dist/index.js）→ ../../package.json，
 * 均指向 ECode 包根。全局安装时也正确（node_modules/ecode/package.json）。
 * 读不到（权限/缺失）降级为 '0.0.0'，不让版本读取阻断启动。
 */
function readAppVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 启动沉浸式 REPL（渲染 <App>）。
 *
 * UI 依赖（ink/react/ui/app）走动态 import：one-shot 路径不加载 GUI 栈，降低 CLI 启动延迟；
 * 仅在确需 REPL 时付出加载成本。render() 接管 stdout 并保持进程常驻，直到用户 /exit 或
 * 双击 Ctrl+C（App 内部处理），故本函数 resolve 后不得再执行任何 process.exit。
 *
 * @param model --model 指定的模型名（缺省交由 agent core 自选默认）
 * @param system 预拼 system prompt（含 CLAUDE.md/ECODE.md 注入）
 * @param permissionMode 初始权限档（CLI flag / settings.defaultMode 推导）
 * @param denyRules settings.json 加载的 deny 规则
 * @param hooks settings.json 加载的 hooks 配置
 */
async function startRepl(
  model: string | undefined,
  system: string,
  permissionMode: PermissionMode,
  denyRules: Rule[],
  hooks: HookDef[],
): Promise<void> {
  const projectRoot = process.cwd();
  const version = readAppVersion();
  const { render } = await import('ink');
  const React = (await import('react')).default;
  const { App } = await import('./ui/app.js');
  // index.ts 为 .ts（非 .tsx），不能写 JSX；用 createElement 等价表达 <App .../>。
  render(
    React.createElement(App, {
      model,
      cwd: projectRoot,
      system,
      version,
      permissionMode,
      denyRules,
      hooks,
    }),
    {
      // exitOnCtrlC: false —— 关掉 ink 默认的「Ctrl+C 直接退出」（render.js 默认 true）。
      // 默认 true 时 ink 在 stdin 层（components/App.js:151 拦 \x03）直接 process.exit，
      // app.tsx 的「单击中断对话 / 双击退出」逻辑（详设 docs/详设/20260807000318）变成死代码、
      // 一次 Ctrl+C 就退。关掉后 Ctrl+C 交给 app.tsx useInput 处理：
      //   单击 = 中断流（streaming→abort，非 streaming 仅进退出窗口）
      //   双击(2s 内) = process.exit(0)
      //   Esc 只清空输入/关弹窗，不中断对话（与 Ctrl+C 分工）
      exitOnCtrlC: false,
      // Kitty 键盘协议（详设 docs/详设/20260808150000 §3.1）：auto 模式自动检测终端支持，
      // 启用后 Shift+Enter 发 \x1b[13;2u 被 ink 原生解析为 {return, shift:true}，
      // 使多行输入的换行键可用。不支持 Kitty 的终端静默跳过（ink auto 不误开），
      // 靠 Alt+Enter / 反斜杠续行兜底。ink 在 unmount 时自动发还原序列，无需手动清理。
      kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
    },
  );
}

// ============================================================
// 命令分流
// ============================================================

// ---- --list-models ----
if (values['list-models']) {
  console.log('可用模型：');
  for (const m of listAvailableModels()) {
    console.log(`  ${m.model} (provider: ${m.provider})`);
  }
  process.exit(0);
}

// ---- --sessions:列出全部会话(不调 LLM)----
if (values.sessions) {
  const list = listSessions();
  if (list.length === 0) {
    console.log('暂无会话记录。');
    process.exit(0);
  }
  console.log('会话列表(按更新时间倒序):\n');
  console.log('ID                更新时间              轮数  工具调用  任务');
  for (const s of list) {
    const taskPreview = s.task.length > 30 ? `${s.task.slice(0, 30)}...` : s.task;
    console.log(
      `${s.id.padEnd(18)}${formatTime(s.updatedAt).padEnd(22)}${String(s.stats.rounds).padStart(4)}  ${String(s.stats.toolCalls).padStart(8)}  ${taskPreview}`,
    );
  }
  process.exit(0);
}

// ---- --continue / --resume:续接族 ----
const wantContinue = values['continue'] === true;
const wantResume = values.resume !== undefined;

// M4 阶段 4：一次性解析权限档 + 加载 deny 规则（非法 mode 早 fatal；bypass 跳过加载）。
const perm = resolvePermission();

if (wantContinue || wantResume) {
  // 确定 id:--continue 取最近;--resume 用指定值
  const id = wantContinue ? latestSessionId() : values.resume;
  if (!id) {
    fatal('没有可恢复的会话。用 ecode "<任务>" 开始新会话,或 ecode --sessions 查看。');
  }

  let session: ECodeSession;
  try {
    session = loadSession(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      fatal(`找不到会话 ${id}。用 ecode --sessions 查看会话列表。`);
    }
    fatal(`加载会话 ${id} 失败:${err instanceof Error ? err.message : String(err)}`);
  }

  const newTask = positionals[0];

  // 无任务 → 纯恢复:打印详情摘要,不调 LLM(决策①)
  if (!newTask) {
    const preview = lastAssistantText(session).slice(0, 200).replace(/\n/g, ' ');
    console.log(`\n📋 会话 ${session.id}`);
    console.log(`   任务: ${session.task}`);
    console.log(`   模型: ${session.model}`);
    console.log(
      `   轮数: ${session.stats.rounds} | 工具调用: ${session.stats.toolCalls}${session.stats.compressed ? ' | (已压缩)' : ''}`,
    );
    console.log(`   创建: ${formatTime(session.createdAt)} | 更新: ${formatTime(session.updatedAt)}`);
    console.log(`   消息: ${session.messages.length} 条`);
    if (preview) {
      console.log(`   最后回复: ${preview}`);
    }
    console.log('\n(纯恢复模式,未调用 LLM。要继续对话:ecode --continue "新指令")\n');
    process.exit(0);
  }

  // 有任务 → 续接跑(复用原 id 续写同一文件,决策③A)
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (!controller.signal.aborted) controller.abort();
  });
  const projectRoot = process.cwd();
  const instructions = buildSystemInstructions(projectRoot);
  const system = buildSystemPrompt(instructions);

  runAgent(newTask, values.model, {
    resumed: {
      id: session.id,
      task: session.task,
      createdAt: session.createdAt,
      messages: session.messages,
    },
    signal: controller.signal,
    system,
    permissionMode: perm.mode,
    denyRules: perm.denyRules,
  }).catch((err) => {
    console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // ---- 新会话 / REPL：双模式入口分流（spec §八 阶段②验收）----
  // 指令/CLAUDE.md 加载在两个分支都要用（REPL 同样把 system prompt 注入 agent），
  // 故在此处统一加载，再按模式分流。
  const projectRoot = process.cwd();
  const instructions = buildSystemInstructions(projectRoot);
  const system = buildSystemPrompt(instructions);

  const mode = selectEntryMode({
    replFlag: values.repl === true,
    // 用 truthiness（非空字符串）而非 length：`ecode ""` 传空串本就不是有效任务，
    // 与原 `if (!task)` 守卫语义一致——空任务回退到 REPL/usage，不送空串给 agent。
    hasTask: !!positionals[0],
    isTTY: process.stdout.isTTY === true,
  });

  if (mode === 'repl') {
    // REPL：渲染 <App>，进程常驻至用户退出。render() 内部接管 stdout，
    // 故这里用 .catch 兜底动态 import 失败（如 ink 缺包），不 silent hang。
    startRepl(values.model, system, perm.mode, perm.denyRules, perm.hooks).catch((err) => {
      console.error('\n💥 REPL 启动失败:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  } else if (mode === 'usage') {
    // 无任务 + 非 TTY（管道/CI）：打印用法退出，避免 Ink 抢占无输入源 stdin。
    printUsage();
    process.exit(1);
  } else {
    // one-shot：保留现状 ecode "任务" 逐字流式。
    const task = positionals[0];
    const controller = new AbortController();
    process.on('SIGINT', () => {
      if (!controller.signal.aborted) controller.abort();
    });

    runAgent(task, values.model, {
      signal: controller.signal,
      system,
      permissionMode: perm.mode,
      denyRules: perm.denyRules,
    }).catch((err) => {
      console.error('\n💥 致命错误:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  }
}
