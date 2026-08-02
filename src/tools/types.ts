// 工具层共享类型与常量

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** 工具输出截断上限，防止撑爆 LLM 上下文 */
export const MAX_OUTPUT_LENGTH = 30_000;
