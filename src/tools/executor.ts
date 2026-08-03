import { ToolResult } from './types.js';
import { toolDefinitions } from './registry.js';
import { executeReadFile } from './read-file.js';
import { executeBash } from './bash.js';
import { executeEditFile } from './edit-file.js';
import { executeGrep } from './grep.js';
import { executeGlob } from './glob.js';

/**
 * 工具分发器：按工具名路由到具体实现。
 * 新增工具：① registry.ts 加 schema(含 required) ② 这里加 case ③ 实现工具函数
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // 参数校验：required 字段缺失时直接返回 isError,不进入工具实现
  const definition = toolDefinitions.find((t) => t.name === name);
  if (!definition) {
    return { content: `未知工具: ${name}`, isError: true };
  }
  const required = definition.parameters.required ?? [];
  for (const field of required) {
    if (input[field] == null) {
      return { content: `参数缺失: ${field}`, isError: true };
    }
  }

  switch (name) {
    case 'read_file':
      return executeReadFile(input as { path: string });
    case 'bash':
      return executeBash(input as { command: string });
    case 'edit_file':
      return executeEditFile(
        input as { path: string; oldText: string; newText: string },
      );
    case 'grep':
      return executeGrep(input as { pattern: string; path?: string; include?: string });
    case 'glob':
      return executeGlob(input as { pattern: string; path?: string });
    default:
      // schema 中有定义但 executor 没实现——理论上不该发生,但防御兜底
      return { content: `工具未实现: ${name}`, isError: true };
  }
}
