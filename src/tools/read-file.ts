import { readFile } from 'node:fs/promises';
import { ToolResult } from './types.js';
import { truncateByLines } from './truncate.js';

export async function executeReadFile(input: { path: string }): Promise<ToolResult> {
  try {
    const content = await readFile(input.path, 'utf-8');
    return { content: truncateByLines(content), isError: false };
  } catch (err) {
    return {
      content: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
