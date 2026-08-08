import { resolve, relative, isAbsolute, basename } from 'node:path';

/**
 * 路径守卫：越界检测 + 敏感文件黑名单。
 * M4 阶段 1 硬安全网（纯函数，零 I/O），阶段 2 由 rule-engine.check() 接线。
 * 黑名单抄自 CC filesystem.ts:57-79；越界判定仿 opencode external-directory.ts。
 */

/** 编辑/读取这些文件总是 ask（即使 acceptEdits 模式）—— 抄 CC DANGEROUS_FILES */
export const DANGEROUS_FILES = [
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile', '.ripgreprc',
  '.mcp.json', '.claude.json', '.env', '.env.*',
];

/** 这些目录下的文件总是 ask —— 抄 CC DANGEROUS_DIRECTORIES */
export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude', '.ecode'];

/**
 * target 是否在 root 内（含 root 自身）。
 * 用 path.relative 检测 '..' 越界；跨盘符（Windows）relative 返回绝对路径 → 算外部。
 */
export function isInside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return true; // target 即 root
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** target 是否在所有 roots 之外（越界）。任一 root 包含即非外部。 */
export function isExternalDirectory(target: string, roots: string[]): boolean {
  return !roots.some((root) => isInside(target, root));
}

/** basename 是否命中危险文件黑名单（精确 + `.*` 通配，如 `.env.*`）。 */
function matchDangerousBase(base: string): boolean {
  for (const pat of DANGEROUS_FILES) {
    if (pat.endsWith('.*')) {
      const prefix = pat.slice(0, -2); // '.env'
      if (base === prefix || base.startsWith(`${prefix}.`)) return true;
    } else if (base === pat) {
      return true;
    }
  }
  return false;
}

/** targetPath 是否为敏感文件（basename 命中黑名单 或 路径落在危险目录下）。 */
export function isDangerousFile(targetPath: string): boolean {
  if (!targetPath) return false;
  if (matchDangerousBase(basename(targetPath))) return true;
  // 跨平台分隔符（Windows \ / Unix /，输入可能混合）
  const segments = targetPath.split(/[\\/]/);
  return segments.some((seg) => DANGEROUS_DIRECTORIES.includes(seg));
}

export interface PathSafety {
  /** 路径在工作区 roots 之外（越界写） */
  external: boolean;
  /** 命中敏感文件/目录黑名单 */
  dangerousFile: boolean;
}

/** 综合：越界 + 敏感文件。任一命中即应升级到 ask。 */
export function checkPathSafety(targetPath: string, roots: string[]): PathSafety {
  return {
    external: isExternalDirectory(targetPath, roots),
    dangerousFile: isDangerousFile(targetPath),
  };
}
