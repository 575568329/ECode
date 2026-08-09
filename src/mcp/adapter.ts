// MCP（支点 10）adapter —— MCP tool/prompt 描述符 → ECode ToolDefinition / SlashCommandDef。
//
// 依赖 SDK 类型形状（已联网核实，v1.30.0）：
//   Tool: { name, description?, inputSchema: {type:"object", properties?, required?}, annotations? }
//   Prompt: { name, description?, arguments?: [{name, description?, required?}] }
//   CallToolResult: { content: Content[], isError?, structuredContent? }
//
// 不 spawn、不连接——纯类型适配（testable 无 SDK mock）。
import type { ToolDefinition } from '../tools/types.js';
import type { SlashCommandDef, CommandHandler } from '../slash-commands.js';
import type {
  Tool as McpTool,
  Prompt as McpPrompt,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * 将 MCP tool 描述符适配为 ECode ToolDefinition。
 *
 * 关键设计：
 *   - 命名空间：`mcp__<serverName>__<toolName>`（仿 CC，避免不同 server 同名工具冲突）。
 *   - dangerous: true（MCP = 不可信代码，统一走 check/审批）。
 *   - execute: 闭包调用 connection.callTool（由 loader 在连接后注入）。
 *   - inputSchema 直接透传（JSON Schema → ECode parameters 形状一致）。
 */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpTool,
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): ToolDefinition {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? '',
    parameters: mcpTool.inputSchema as ToolDefinition['parameters'],
    dangerous: true,
    execute: async (input) => {
      const result = await callTool(mcpTool.name, (input ?? {}) as Record<string, unknown>);
      // MCP content 数组 → ECode 纯文本（取 text 类型的 text 字段拼接）
      const textParts = result.content
        ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text) ?? [];
      return {
        content: textParts.join('\n'),
        isError: result.isError ?? false,
      };
    },
  };
}

/**
 * 将 MCP prompt 描述符适配为斜杠命令（MCP Prompts → `/mcp__server__prompt`）。
 *
 * 关键设计（双源共识，实施方案 10-T3a）：
 *   - 位置参数 → arguments map（argNames[i] ↔ argv[i]）。
 *   - execute: 调用 client.getPrompt → 注入结果作为 user message。
 *   - argNames 给 typeahead 生成 [arg] hint。
 */
export function adaptMcpPrompt(
  serverName: string,
  mcpPrompt: McpPrompt,
  getPrompt: (name: string, args: Record<string, string>) => Promise<{ messages: unknown[] }>,
  injectAsUserMessage: (messages: unknown[]) => void,
): SlashCommandDef & { execute: CommandHandler } {
  const argNames = mcpPrompt.arguments?.map((a) => a.name) ?? [];

  return {
    name: `mcp__${serverName}__${mcpPrompt.name}`,
    description: mcpPrompt.description ?? '',
    argNames,
    source: 'mcp',
    execute: async (argv) => {
      // 位置参数 → 具名 map（缺参空串）
      const argMap: Record<string, string> = {};
      for (let i = 0; i < argNames.length; i++) {
        argMap[argNames[i]] = argv[i] ?? '';
      }
      try {
        const result = await getPrompt(mcpPrompt.name, argMap);
        injectAsUserMessage(result.messages);
      } catch (err) {
        console.warn(`[MCP] 获取 prompt "${mcpPrompt.name}" 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
