import { rmSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { ToolResult } from './types.js';

export interface DeleteFileInput {
  path: string;
  recursive?: boolean;
}

/**
 * 删除文件或目录。
 *
 * - recursive 默认 false:只删文件或空目录;
 *   非空目录 → fail-fast 返回明确错误(而非 Node 隐式 ENOTEMPTY),引导 LLM 加 recursive 重试;
 * - 空目录用 rmdirSync(明确空目录语义,Windows 可靠;rmSync 对目录 recursive:false 在 Win 上不稳);
 * - recursive=true:递归删除(对标 rm -r),rmSync { recursive, force:false }
 *   (force:false 防误删不存在路径静默成功)。
 */
export function executeDeleteFile(input: DeleteFileInput): ToolResult {
  try {
    const recursive = input.recursive ?? false;
    const stat = statSync(input.path); // 不存在 → 抛 → catch 返回失败
    if (!recursive && stat.isDirectory()) {
      const entries = readdirSync(input.path);
      if (entries.length > 0) {
        return {
          content: `删除非空目录需要 recursive=true:${input.path}(含 ${entries.length} 项)`,
          isError: true,
        };
      }
      rmdirSync(input.path); // 空目录
      return { content: `已删除 ${input.path}`, isError: false };
    }
    rmSync(input.path, { recursive, force: false });
    return { content: `已删除 ${input.path}`, isError: false };
  } catch (err) {
    return {
      content: `删除失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
