import type { PermissionMode, PermissionVerdict, Rule } from './types.js';
import type { AllowList } from '../permission.js';
import { checkPathSafety } from './path-guard.js';
import { splitCompound } from './arity.js';
import { match } from './wildcard.js';

/** acceptEdits 模式自动放行的编辑工具集 */
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

export interface CheckOptions {
  toolName: string;
  input: Record<string, unknown>;
  isDangerous: boolean;
  mode: PermissionMode;
  /** session allow_always（工具名粒度 + bash 命令 pattern） */
  allow: AllowList;
  /** 工作区根目录集合（阶段 2 单根 [process.cwd()]，阶段 4 支持 additionalDirectories） */
  roots: string[];
  /**
   * settings.json 配置的 deny 规则（user + project 两层合并）。
   * 最强用户意图：任一命中即短路 deny（早于 path-guard / allow）。
   * 未传 = 无 deny 配置源（阶段 2/3 兼容，不破坏现有测试）。
   */
  denyRules?: Rule[];
}

/**
 * 判定是否命中任一 deny 规则（check() step 2 用）。
 * - bash：拆 compound 段，任一段命中 pattern 即 deny（与 allow「全段命中才放行」相反——
 *   deny 一段危险即整条拒绝，宁可错杀）。
 * - 文件工具：pattern='*' 通配命中；否则按 pattern 是否含路径分隔符决定匹配目标——
 *   无分隔符（如 '.env'）匹配 basename（覆盖「禁止编辑 .env」常见场景，不受绝对路径前缀干扰）；
 *   含分隔符（如 'src/secret/*'）匹配完整路径（路径前缀作用域）。
 * - 无 input.path 且 pattern≠'*' 的非 bash 工具（如 grep 的 pattern 字段）：不匹配（M4 deny 仅覆盖 bash/路径）。
 */
function matchesAnyDeny(toolName: string, input: Record<string, unknown>, denyRules: Rule[]): boolean {
  for (const rule of denyRules) {
    if (rule.action !== 'deny') continue;
    if (rule.tool !== '*' && rule.tool !== toolName) continue;
    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      const segments = splitCompound(command);
      if (segments.some((seg) => match(seg, rule.pattern))) return true;
    } else {
      if (rule.pattern === '*') return true;
      const targetPath = typeof input.path === 'string' ? input.path : '';
      if (!targetPath) continue;
      const againstSeparator = /[\\/]/.test(rule.pattern);
      const against = againstSeparator ? targetPath : (targetPath.split(/[\\/]/).pop() ?? targetPath);
      if (match(against, rule.pattern)) return true;
    }
  }
  return false;
}

/**
 * 主权限判定（替代 shouldAsk 的角色；shouldAsk 保留作档 A 兼容）。
 * 判定顺序（短路，越靠前优先级越高）：
 *  1. bypass → 全放行（短路在 deny/path-guard 之前，绕过硬安全网，仿 CC bypassPermissions 免疫 safetyCheck）
 *  2. deny 规则（settings 配置）：任一段/路径命中 → deny（最强用户意图，早于 path-guard）
 *  3. path-guard：提取 input.path，越界或敏感文件 → ask（硬安全网，任何非 bypass 模式都问）
 *  4. session allow_always 整工具命中（allow.has）→ allow
 *  4.5 bash 专用：命令 pattern 分级（空命令 ask；compound 每段命中 pattern 才 allow，否则 ask）
 *  5. acceptEdits + 编辑工具（非敏感已在 3 拦下）→ allow
 *  6. isDangerous → ask
 *  7. 否则 → allow（只读工具）
 *
 * 运行时用户 deny（gate 返回 deny）由 agent.ts 处理（不进 check()）；check() 只管策略层 deny。
 */
export function check(opts: CheckOptions): PermissionVerdict {
  const { toolName, input, isDangerous, mode, allow, roots, denyRules } = opts;

  // 1. bypass：开发调试，全自动（绕过 deny / path-guard 硬安全网）
  if (mode === 'bypass') {
    return { action: 'allow', reason: 'bypass 模式：自动放行（绕过安全网）' };
  }

  // 2. deny 规则（settings.json 配置）：任一命中即拒绝（最强用户意图）
  if (denyRules && denyRules.length > 0 && matchesAnyDeny(toolName, input, denyRules)) {
    return { action: 'deny', reason: '命中配置的 deny 规则' };
  }

  // 3. path-guard：越界或敏感文件 → ask（硬安全网）
  const targetPath = typeof input.path === 'string' ? input.path : '';
  if (targetPath) {
    const safety = checkPathSafety(targetPath, roots);
    if (safety.external) {
      return { action: 'ask', reason: `路径越界：${targetPath} 不在工作区内` };
    }
    if (safety.dangerousFile) {
      return { action: 'ask', reason: `敏感文件：${targetPath}` };
    }
  }

  // 3. session allow_always 命中 → 放行（整工具粒度，含 bash 的「整工具 always」逃生口）
  if (allow.has(toolName)) {
    return { action: 'allow', reason: `本会话已批准：${toolName}` };
  }

  // 4.5 bash 专用：按命令 pattern 分级（ls 与 rm -rf 不同待遇）。
  // 空命令 → ask；有命令 → 拆 compound 段，每段都须命中已批准 pattern 才放行（防 && 绕过）。
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) {
      return { action: 'ask', reason: 'bash：空命令待审批' };
    }
    const segments = splitCompound(command);
    if (allow.hasBashPermission(segments)) {
      return { action: 'allow', reason: '本会话已批准的命令模式' };
    }
    return { action: 'ask', reason: `bash 命令待审批：${command}` };
  }

  // 5. acceptEdits：编辑工具自动放行（敏感文件已在 step 3 拦下）
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) {
    return { action: 'allow', reason: 'acceptEdits：自动放行编辑工具' };
  }

  // 6. 危险工具 → ask
  if (isDangerous) {
    return { action: 'ask', reason: `危险工具：${toolName}` };
  }

  // 7. 默认放行（只读工具）
  return { action: 'allow', reason: '只读工具：放行' };
}
