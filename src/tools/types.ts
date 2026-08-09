// 工具层共享类型与常量

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object',
    properties: Record<string, unknown>,
    required?: string[],
  };
  /**
   * 工具执行函数（声明式 ⑦）。
   * 挂在定义上后，executor.ts 无需 switch —— 按 name find 后直接调 execute。
   * executor 的 try/catch 降级保护依然保留在调用方。
   */
  execute?: (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
  /** P5 预留：标记工具是否只读可并行（如 glob/grep 可并发，edit_file 不行） */
  parallelizable?: boolean;
  /**
   * 是否危险操作（需权限审批）。
   * 档A（CCode 式）：bash 等副作用工具标 true，触发 permissionGate 询问；
   * read_file/grep/glob 等只读工具不标（undefined 视为 false，直接放行）。
   */
  dangerous?: boolean;
}

/**
 * 工具返回结果（v2: 与 ECodeToolResultOutput 对齐）。
 * 工具函数返回 ToolResult，executor/agent 将其转为 ECodeContentBlock(type:'tool_result')。
 */
/** 工具结果元数据（可选；子代理 Task 工具填充，供气泡显示模型+路由来源，§16.5）。 */
export interface ToolResultMetadata {
  model?: string;
  provider?: string;
  /** 路由来源（宽松 string，避免 tools→router 反向依赖）：persona|complexity|rule|default。 */
  routingSource?: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** 可选元数据（向后兼容，其他工具不填）。 */
  metadata?: ToolResultMetadata;
}

/** 工具输出截断上限，防止撑爆 LLM 上下文 */
export const MAX_OUTPUT_LENGTH = 30_000;
