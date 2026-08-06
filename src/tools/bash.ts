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
      // execSync 失败时 err.message 格式为 "Command failed: <cmd>\n<stderr>"——
      // cmd 与 UI 标题里的命令重复，对 agent 排错也是噪声。优先取 err.stderr（纯 stderr），
      // 仅在无 stderr（如命令本身不存在等 spawn 级失败）时回退 err.message。
      const stderr = (err as { stderr?: unknown }).stderr;
      const detail =
        typeof stderr === 'string'
          ? stderr
          : Buffer.isBuffer(stderr)
            ? stderr.toString('utf-8')
            : '';
      return { content: truncate(detail || err.message), isError: true };
    }
    return { content: `执行失败: ${String(err)}`, isError: true };
  }
}
