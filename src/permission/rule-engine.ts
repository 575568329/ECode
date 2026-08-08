import type { PermissionMode, PermissionVerdict } from './types.js';
import type { AllowList } from '../permission.js';
import { checkPathSafety } from './path-guard.js';

/** acceptEdits 模式自动放行的编辑工具集 */
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

export interface CheckOptions {
  toolName: string;
  input: Record<string, unknown>;
  isDangerous: boolean;
  mode: PermissionMode;
  /** session allow_always（工具名粒度，阶段 2）；阶段 3 起替换为 Rule[] */
  allow: AllowList;
  /** 工作区根目录集合（阶段 2 单根 [process.cwd()]，阶段 4 支持 additionalDirectories） */
  roots: string[];
}

/**
 * 主权限判定（替代 shouldAsk 的角色；shouldAsk 保留作档 A 兼容）。
 * 判定顺序（短路，越靠前优先级越高）：
 *  1. bypass → 全放行（短路在 path-guard 之前，绕过硬安全网，仿 CC bypassPermissions 免疫 safetyCheck）
 *  2. path-guard：提取 input.path，越界或敏感文件 → ask（硬安全网，任何非 bypass 模式都问）
 *  3. session allow_always 命中（allow.has）→ allow
 *  4. acceptEdits + 编辑工具（非敏感已在 2 拦下）→ allow
 *  5. isDangerous → ask
 *  6. 否则 → allow（只读工具）
 *
 * deny 留到阶段 4 settings-loader；阶段 2 无配置源，运行时 deny 只来自 gate 用户拒绝。
 */
export function check(opts: CheckOptions): PermissionVerdict {
  const { toolName, input, isDangerous, mode, allow, roots } = opts;

  // 1. bypass：开发调试，全自动（绕过 path-guard 硬安全网）
  if (mode === 'bypass') {
    return { action: 'allow', reason: 'bypass 模式：自动放行（绕过安全网）' };
  }

  // 2. path-guard：越界或敏感文件 → ask（硬安全网）
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

  // 3. session allow_always 命中 → 放行
  if (allow.has(toolName)) {
    return { action: 'allow', reason: `本会话已批准：${toolName}` };
  }

  // 4. acceptEdits：编辑工具自动放行（敏感文件已在 step 2 拦下）
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) {
    return { action: 'allow', reason: 'acceptEdits：自动放行编辑工具' };
  }

  // 5. 危险工具 → ask
  if (isDangerous) {
    return { action: 'ask', reason: `危险工具：${toolName}` };
  }

  // 6. 默认放行（只读工具）
  return { action: 'allow', reason: '只读工具：放行' };
}
