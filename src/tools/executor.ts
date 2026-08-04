import { ToolResult } from './types.js';
import { toolDefinitions } from './registry.js';

/**
 * 工具分发器（v2 声明式）。
 * 按工具名 find 定义 → 参数校验 → 调定义上的 execute。
 * 无 switch：新增工具只需在 registry.ts 加一条，无需改此文件。
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  // 按 name 查找工具定义
  const definition = toolDefinitions.find((t) => t.name === name);
  if (!definition) {
    return { content: `未知工具: ${name}`, isError: true };
  }

  // 参数校验：required 字段缺失时直接返回 isError,不进入工具实现
  const required = definition.parameters.required ?? [];
  for (const field of required) {
    if (input[field] == null) {
      return { content: `参数缺失: ${field}`, isError: true };
    }
  }

  // 调声明式 execute（定义上没有 execute 的 → 返回"未实现"）
  if (!definition.execute) {
    return { content: `工具未实现: ${name}`, isError: true };
  }

  // execute 返回 ToolResult 或 Promise<ToolResult>（glob 是 async）
  return definition.execute(input);
}
