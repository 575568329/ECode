import fg from 'fast-glob';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

export interface GlobInput {
  pattern: string;
  path?: string; // 搜索根目录，默认 cwd
}

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

// 按文件名模式查找文件（如 ** 下递归匹配 .ts）。用 fast-glob（成熟、纯 JS）。
export async function executeGlob(input: GlobInput): Promise<ToolResult> {
  const cwd = input.path ?? process.cwd();
  try {
    const files = await fg(input.pattern, {
      cwd,
      ignore: DEFAULT_IGNORE,
      dot: false,
      onlyFiles: true,
    });
    if (files.length === 0) {
      return { content: '未找到匹配文件。', isError: false };
    }
    return { content: truncate(files.sort().join('\n'), 30_000), isError: false };
  } catch (err) {
    return {
      content: `glob 失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
