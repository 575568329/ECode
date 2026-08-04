import { readFileSync } from 'node:fs';
import { ToolResult } from './types.js';
import { truncateByLines } from './truncate.js';

export function executeReadFile(input: { path: string }): ToolResult {
  try {
    const content = readFileSync(input.path, 'utf-8');
    return { content: truncateByLines(content), isError: false };
  } catch (err) {
    return {
      content: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
