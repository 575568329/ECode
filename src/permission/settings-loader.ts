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
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { PermissionMode, Rule, RuleAction } from './types.js';

/** 公开（测试/复用）的 settings.json 形状。 */
export interface PermissionSettingsFile {
  defaultMode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
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

/** 安全读 JSON 文件：缺失 / 解析失败 → undefined（绝不抛，避免一条坏配置砖住启动）。 */
function readSettingsJson(path: string): PermissionSettingsFile | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PermissionSettingsFile;
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
}

/**
 * 读 ~/.ecode/settings.json（user）+ 项目 .ecode/settings.json（project），合并。
 * 默认路径自探测（§9.3：数据目录走 .ecode，不依赖外部环境）。
 */
export function loadPermissionSettings(
  opts: LoadPermissionSettingsOptions = {},
): LoadedPermissionSettings {
  const userDir = opts.userDir ?? resolve(homedir(), '.ecode');
  const projectDir = opts.projectDir ?? resolve(process.cwd(), '.ecode');
  const initialMode = opts.initialMode ?? 'default';

  // 两层按 [user, project] 顺序加载；project 后加载 → defaultMode 取后者（project 胜）。
  const layers: Array<{ file: PermissionSettingsFile | undefined; source: Rule['source'] }> = [
    { file: readSettingsJson(resolve(userDir, 'settings.json')), source: 'user' },
    { file: readSettingsJson(resolve(projectDir, 'settings.json')), source: 'project' },
  ];

  let mode = initialMode;
  const rules: Rule[] = [];
  for (const layer of layers) {
    if (!layer.file) continue;
    if (layer.file.defaultMode) mode = layer.file.defaultMode;
    rules.push(...buildRulesFromSettings(layer.file, layer.source));
  }
  return { mode, rules };
}
