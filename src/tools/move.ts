import { renameSync, mkdirSync, cpSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolResult } from './types.js';

export interface MoveInput {
  source: string;
  destination: string;
}

/**
 * 移动/重命名文件或目录(rename 语义,目标已存在则覆盖)。
 *
 * - 自动创建 destination 的嵌套目录;
 * - renameSync 跨设备会抛 EXDEV → fallback cpSync + rmSync(copy + delete),
 *   兼容 WSL↔Windows 等混合环境(见 CLAUDE.md §9.3);
 * - source 不存在 → fail-fast 明确错误。
 */
export function executeMove(input: MoveInput): ToolResult {
  try {
    if (!existsSync(input.source)) {
      return { content: `源不存在: ${input.source}`, isError: true };
    }
    mkdirSync(dirname(input.destination), { recursive: true });
    try {
      renameSync(input.source, input.destination);
    } catch (renameErr) {
      if (!isExdev(renameErr)) throw renameErr;
      // EXDEV 跨设备 → copy + delete
      if (statSync(input.source).isDirectory()) {
        cpSync(input.source, input.destination, { recursive: true });
      } else {
        cpSync(input.source, input.destination);
      }
      rmSync(input.source, { recursive: true, force: false });
    }
    return { content: `已移动 ${input.source} → ${input.destination}`, isError: false };
  } catch (err) {
    return {
      content: `移动失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function isExdev(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EXDEV';
}
