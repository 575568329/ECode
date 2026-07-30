import { execSync } from 'node:child_process';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

export function executeBash(input: { command: string }): ToolResult {
  try {
    const output = execSync(input.command, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return { content: truncate(output), isError: false };
  } catch (err) {
    if (err instanceof Error) {
      // execSync 执行失败时（exit code != 0），stderr 在 error.message 里
      return { content: truncate(err.message), isError: true };
    }
    return { content: `执行失败: ${String(err)}`, isError: true };
  }
}
