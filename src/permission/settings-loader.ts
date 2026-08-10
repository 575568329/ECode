/**
 * M4 阶段 4：权限配置加载器。
 *
 * 职责：
 *   1. 解析规则字符串 "Bash(rm -rf *)" → { tool, pattern }（抄 CC/opencode 规则语法）。
 *   2. 读两层 settings.json（user ~/.ecode + project .ecode），扁平合并成 Rule[]。
 *
 * 设计（对齐 M4 交叉验证报告 §4.6/§4.7）：
 *   - 2 层配置（非 CC 5 层）：project 后于 user 加载 → defaultMode 取后加载层（project 胜）；
 *     allow/deny/ask 规则数组「并集」（deny 增量、不覆盖），由 check() 决定优先级（deny > ask > allow）。
 *   - 规则字符串：`Tool(pattern)`。工具名别名归一（Bash→bash、Edit→edit_file，与 ECode 工具名对齐）。
 *   - 非法规则静默跳过（不抛，避免一条坏配置砖住整个启动）。
 *
 * 不在本模块（留 check() / agent.ts）：
 *   - Rule 匹配逻辑（bash 按 arity 段匹配、文件工具按路径匹配）。
 *   - 内存层会话规则（AllowList，运行时 allow_always 累积，不写盘）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDataDir } from '../paths.js';
import type { PermissionMode, Rule, RuleAction } from './types.js';
import type { HookDef, HookEvent } from '../hooks/types.js';

/** 公开（测试/复用）的 settings.json 形状。 */
export interface PermissionSettingsFile {
  defaultMode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
  /** hooks 配置（支点 12）：事件 + 命令 + 可选 matcher。source 由加载层自动标记。 */
  hooks?: Array<{ event: string; command: string; matcher?: string }>;
}

/**
 * 工具名别名归一表：规则字符串用 CC 式大写首字母（Bash/Edit），ECode 工具名是小写带下划线（bash/edit_file）。
 * 未知工具名一律小写化（Custom → custom），避免大小写歧义。
 */
const TOOL_ALIASES: Record<string, string> = {
  Bash: 'bash',
  Edit: 'edit_file',
  Write: 'write_file',
  Read: 'read_file',
  Glob: 'glob',
  Grep: 'grep',
  Ls: 'ls',
};

/**
 * 解析规则字符串 "Tool(pattern)" → { tool, pattern }。
 * - 工具名须字母/下划线/* 开头，后随字母数字/下划线/*（拒绝数字开头）。
 * - pattern 贪婪保留到最后一个 ')'，使 pattern 内含括号（如 echo "(hi)"）不被误截。
 * - 空 pattern（Bash()）/ 缺右括号 / 非法工具名 → null（调用方静默跳过）。
 */
export function parseRuleString(raw: string): { tool: string; pattern: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([A-Za-z_*][A-Za-z0-9_*]*)\s*\((.*)\)\s*$/);
  if (!match) return null;
  const [, rawTool, pattern] = match;
  if (!pattern) return null; // 空 pattern 无匹配意义
  const tool = TOOL_ALIASES[rawTool] ?? rawTool.toLowerCase();
  return { tool, pattern };
}

/** 单层 settings 对象 → Rule[]（allow/deny/ask 各转 action，非法字符串跳过）。纯函数，无 I/O。 */
export function buildRulesFromSettings(
  file: PermissionSettingsFile,
  source: Rule['source'],
): Rule[] {
  const rules: Rule[] = [];
  const push = (raws: string[] | undefined, action: RuleAction): void => {
    if (!raws) return;
    for (const raw of raws) {
      const parsed = parseRuleString(raw);
      if (parsed) rules.push({ ...parsed, action, source });
    }
  };
  push(file.allow, 'allow');
  push(file.deny, 'deny');
  push(file.ask, 'ask');
  return rules;
}

/** 合法的 HookEvent 名称集合（用于校验 settings.json hooks 字段）。
 *  须与 hooks/types.ts HookEvent 联合类型保持同步（新增事件需同步更新此处）。
 */
const VALID_HOOK_EVENTS = new Set<string>([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
]);

/**
 * settings.json hooks 数组 → HookDef[]（非法条目静默跳过）。
 * source 由加载层标记（user/project），不依赖配置文件内容。
 */
function buildHooksFromSettings(
  raw: PermissionSettingsFile['hooks'],
  source: HookDef['source'],
): HookDef[] {
  if (!raw || !Array.isArray(raw)) return [];
  const result: HookDef[] = [];
  for (const item of raw) {
    if (!item.event || !item.command) continue;
    if (!VALID_HOOK_EVENTS.has(item.event)) continue;
    result.push({
      event: item.event as HookEvent,
      command: item.command,
      matcher: item.matcher ?? '*',
      source,
    });
  }
  return result;
}

/** 安全读 JSON 文件：缺失 / 解析失败 → undefined（绝不抛，避免一条坏配置砖住启动）。 */
function readSettingsJson(path: string): PermissionSettingsFile | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
    // 兼容带 // 注释行（JSON 标准不含注释，逐行 strip，与 providers/config.ts 一致）
    const stripped = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const parsed = JSON.parse(stripped) as PermissionSettingsFile;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined; // 解析失败静默降级（记日志的活儿留上层，本层零依赖）
  }
}

export interface LoadPermissionSettingsOptions {
  userDir?: string;
  projectDir?: string;
  /** CLI flag / 默认值注入的初始模式（被 settings.defaultMode 覆盖，settings 优先）。 */
  initialMode?: PermissionMode;
}

export interface LoadedPermissionSettings {
  /** 最终生效模式：initialMode → user.defaultMode → project.defaultMode（后者胜）。 */
  mode: PermissionMode;
  /** 两层扁平合并后的全部规则（user 在前、project 在后；优先级由 check() 决定）。 */
  rules: Rule[];
  /** 两层扁平合并后的 hooks（user → project）。非法条目静默跳过。 */
  hooks: HookDef[];
}

/**
 * 首启自动生成的默认权限配置（带安全网示例规则，用户可编辑覆盖）。
 * 刻意不含 defaultMode：自动生成的骨架不应表达 mode 偏好，否则 last wins 语义下
 * 「project 层每次不存在就重新生成」会用默认值覆盖用户在 user 层显式选的档。
 * mode 由 initialMode(=default) 或用户显式写的 defaultMode 决定。三档说明见注释头。
 */
const DEFAULT_SETTINGS: PermissionSettingsFile = {
  allow: ['Bash(npm run *)', 'Bash(git status)', 'Bash(ls)'],
  deny: ['Bash(rm -rf *)', 'Bash(git push --force *)', 'Edit(.env)', 'Edit(.env.*)'],
  ask: ['Bash(git push *)'],
};

/** 模板注释头（行首 //；readSettingsJson 会 strip 掉，与 providers/config.ts 同风格）。 */
const SETTINGS_HEADER_LINES = [
  '// ECode 权限配置（首次启动自动生成）',
  '// 修改后重启 ECode 生效。',
  '// 本文件 = 用户级全局默认；项目级覆盖见 <项目>/.ecode/settings.json。',
  '// 入不入 git 由你决定：.ecode/ 默认被 .gitignore 忽略，想入库自行 git add -f 或改自己的 .gitignore。',
  '//',
  '// 三档模式（defaultMode）：',
  '//   default     默认，危险操作弹窗询问（推荐）',
  '//   acceptEdits 自动放行文件编辑（bash 仍按规则），敏感文件 .env/.git 仍询问',
  '//   bypass      跳过全部审批（仅可信环境，等同 --dangerously-skip-permissions）',
  '// CLI 临时覆盖：--permission-mode <default|acceptEdits|bypass>；REPL 中按 Shift+Tab 循环切换。',
  '//',
  '// 规则语法：Tool(pattern)',
  '//   工具名：Bash / Edit / Write / Read / Glob / Grep（首字母大写）',
  '//   pattern：精确 "npm run test"，或通配 "npm run *"（* 匹配任意）',
  '//   allow 放行 / deny 拒绝 / ask 强制询问；bash 复合命令（&&/|/;）逐段校验。',
  '//',
  '// 事件钩子（hooks）：在 agent 生命周期关键事件上挂自定义脚本。',
  '//   event：事件名（见下方列表）',
  '//   command：要执行的 shell 命令',
  '//   matcher：工具名匹配（仅 PreToolUse/PostToolUse 有效，默认 "*" 匹配全部工具）',
  '//',
  '//   支持的事件：',
  '//     SessionStart      会话启动时触发',
  '//     SessionEnd        会话结束时触发',
  '//     UserPromptSubmit  用户提交输入时触发',
  '//     PreToolUse        工具执行前（可 deny 阻止执行 / modifiedInput 替换输入）',
  '//     PostToolUse       工具执行后（可 modifiedOutput 替换输出）',
  '//     Stop              agent 停止时触发',
  '//',
  '//   hooks 示例：',
  '//     { "event": "PreToolUse", "command": "my-linter check", "matcher": "Edit" }',
  '//     { "event": "PostToolUse", "command": "my-formatter fix", "matcher": "Write" }',
];

/** 首次启动生成带注释模板（user/project 两层各自「不存在才生成」；已存在不覆盖）。失败静默降级。 */
function writeSettingsTemplate(dir: string, layer: 'user' | 'project'): void {
  try {
    mkdirSync(dir, { recursive: true });
    const lines =
      layer === 'project'
        ? ['// （项目级：覆盖 ~/.ecode/settings.json，写本项目特有规则即可）', ...SETTINGS_HEADER_LINES]
        : SETTINGS_HEADER_LINES;
    const header = lines.join('\n') + '\n';
    const json = JSON.stringify(DEFAULT_SETTINGS, null, 2);
    writeFileSync(resolve(dir, 'settings.json'), header + json + '\n', 'utf-8');
  } catch {
    // 生成失败（目录权限等）不阻塞启动，静默降级（对齐 providers/config.ts writeConfigTemplate）
  }
}

/**
 * 读 ~/.ecode/settings.json（user）+ 项目 .ecode/settings.json（project），合并。
 * 默认路径自探测（§9.3：数据目录走 .ecode，不依赖外部环境）。
 * 首启自动生成：任一层文件不存在 → 写入带注释模板（对齐 config.json 开箱即用，已存在不覆盖）。
 */
export function loadPermissionSettings(
  opts: LoadPermissionSettingsOptions = {},
): LoadedPermissionSettings {
  const userDir = opts.userDir ?? resolveDataDir();
  const projectDir = opts.projectDir ?? resolve(process.cwd(), '.ecode');
  const initialMode = opts.initialMode ?? 'default';

  // 两层按 [user, project] 顺序加载；project 后加载 → defaultMode 取后者（project 胜）。
  // 每层文件不存在 → 首启自动生成带注释模板（对齐 config.json 开箱即用体验）。
  const layers: Array<{ path: string; dir: string; layer: 'user' | 'project' }> = [
    { path: resolve(userDir, 'settings.json'), dir: userDir, layer: 'user' },
    { path: resolve(projectDir, 'settings.json'), dir: projectDir, layer: 'project' },
  ];

  let mode = initialMode;
  const rules: Rule[] = [];
  const hooks: HookDef[] = [];
  for (const l of layers) {
    if (!existsSync(l.path)) writeSettingsTemplate(l.dir, l.layer);
    const file = readSettingsJson(l.path);
    if (!file) continue;
    if (file.defaultMode) mode = file.defaultMode;
    rules.push(...buildRulesFromSettings(file, l.layer));
    hooks.push(...buildHooksFromSettings(file.hooks, l.layer));
  }
  return { mode, rules, hooks };
}
