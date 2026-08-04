// CLAUDE.md / ECODE.md 兼容读取 —— 4 层回退，ECODE.md 优先。
// 对齐 Claude Code 的 ['CCODE.md','CLAUDE.md'] 回退思想：ECode 品牌名优先，兼容用户已有 CLAUDE.md。
// 纯 IO：调用方传入目录数组（home/cwd 等由上层解析），本函数只读不假设路径。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 每层目录的候选文件名（优先级从高到低） */
const CANDIDATES = ['ECODE.md', 'CLAUDE.md'] as const;

/**
 * 从候选目录读取项目记忆并拼接。
 * @param dirs 目录数组（如 [homeDir, projectRoot, configDir, cwd]）
 * @returns 拼好的项目上下文；全部缺失返回 ''
 */
export function loadInstructions(dirs: string[]): string {
  const sections: string[] = [];
  for (const dir of dirs) {
    const hit = readFirstFound(dir);
    if (hit) sections.push(hit);
  }
  return sections.join('\n\n');
}

/** 单层目录：按 CANDIDATES 顺序找第一个存在的文件，读内容（带来源标注）。 */
function readFirstFound(dir: string): string {
  for (const fname of CANDIDATES) {
    const full = join(dir, fname);
    if (existsSync(full)) {
      // 读不到（权限/编码）会抛 —— 调用方 catch 降级为空，不让记忆读取杀 agent
      const content = readFileSync(full, 'utf8').trim();
      if (content) return `## 项目记忆（${fname} @ ${dir}）\n${content}`;
    }
  }
  return '';
}
