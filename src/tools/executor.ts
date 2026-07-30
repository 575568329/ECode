import { ToolResult } from './types.js';
import { executeReadFile } from './read-file.js';
import { executeBash } from './bash.js';
import { executeEditFile } from './edit-file.js';

/**
 * 工具分发器：按工具名路由到具体实现。
 * 新增工具：① registry.ts 加 schema ② 这里加 case ③ 实现工具函数
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return executeReadFile(input as { path: string });
    case 'bash':
      return executeBash(input as { command: string });
    case 'edit_file':
      return executeEditFile(
        input as { path: string; oldText: string; newText: string },
      );
    default:
      return { content: `未知工具: ${name}`, isError: true };
  }
}
