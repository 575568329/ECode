import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

export interface GrepInput {
  pattern: string;
  path?: string;      // 搜索根目录，默认 cwd
  include?: string;   // 文件名过滤，如 '*.ts'
}

const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'];

/**
 * 按内容搜索文件（正则匹配）。
 * 自实现：递归遍历 + 正则，零二进制依赖；后续可换 ripgrep 提升大库速度。
 * 结果格式：`相对路径:行号: 行内容`，截断到 3 万字符防撑爆上下文。
 */
export function executeGrep(input: GrepInput): ToolResult {
  const root = input.path ?? process.cwd();

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    return {
      content: `正则表达式无效: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const matches: string[] = [];
  try {
    walk(root, root, (filePath) => {
      if (input.include && !matchFileName(filePath, input.include)) return;
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        return; // 二进制 / 无权限等，跳过
      }
      content.split('\n').forEach((line, i) => {
        if (regex.test(line)) {
          matches.push(`${relative(root, filePath)}:${i + 1}: ${line}`);
        }
      });
    });
  } catch (err) {
    return {
      content: `搜索失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  if (matches.length === 0) {
    return { content: '未找到匹配。', isError: false };
  }
  return { content: truncate(matches.join('\n'), 30_000), isError: false };
}

function walk(root: string, dir: string, cb: (path: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.includes(e.name)) continue;
      walk(root, join(dir, e.name), cb);
    } else if (e.isFile()) {
      cb(join(dir, e.name));
    }
  }
}

/** 简单文件名匹配：支持 '*.ext' 后缀匹配与精确名 */
function matchFileName(filePath: string, pattern: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  if (pattern.startsWith('*.') && !pattern.slice(1).includes('*')) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern;
}
