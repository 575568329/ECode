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
 * 扁平化 MCP 错误文本：MCP 错误常是多层嵌套 JSON 字符串
 * （`MCP error -400: {"error":{"message":"{\"msg\":\"...\"}"}}`），LLM 难解析、
 * 看不懂"该换工具"。本函数反复剥嵌套，取出最内层的人类可读 message/msg。
 */
function flattenMcpError(raw: string): string {
  let text = raw;
  for (let depth = 0; depth < 4; depth++) {
    const trimmed = text.trim();
    const braceIdx = trimmed.indexOf('{');
    const jsonPart = braceIdx >= 0 ? trimmed.slice(braceIdx) : trimmed;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPart);
    } catch {
      break; // 已非 JSON，到最内层文本
    }
    if (!parsed || typeof parsed !== 'object') break;
    const obj = parsed as Record<string, unknown>;
    const inner = obj.message ?? obj.msg ?? obj.error;
    if (typeof inner === 'string') {
      text = inner;
      continue;
    }
    if (inner && typeof inner === 'object') {
      const deep = (inner as Record<string, unknown>).msg
        ?? (inner as Record<string, unknown>).message;
      if (typeof deep === 'string') {
        text = deep;
        continue;
      }
    }
    break;
  }
  return text;
}

/**
 * 将 MCP tool 描述符适配为 ECode ToolDefinition。
 *
 * 关键设计：
 *   - 命名空间：`mcp__<serverName>__<toolName>`（仿 CC，避免不同 server 同名工具冲突）。
 *   - dangerous: true（MCP = 不可信代码，统一走 check/审批）。
 *   - execute: 闭包调用 connection.callTool（由 manager 在连接后注入）。
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
      // B：MCP 调用失败（抛异常或返回 isError）一律扁平化错误 + 引导换内置工具。
      //   MCP 自带描述清楚（zread read_file 明说 GitHub 仓库），但 GLM 仍会无视描述选错工具；
      //   且 MCP 错误是多层嵌套 JSON，LLM 解析不出会反复重试同一失败工具。
      //   扁平化解套娃 + "改用内置"提示，让 LLM 失败时能自救换工具。
      let result: CallToolResult;
      try {
        result = await callTool(mcpTool.name, (input ?? {}) as Record<string, unknown>);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // MCP_TIMEOUT 是 client.ts raceWithTimeout 的哨兵串，翻译为中文让 LLM/用户能理解。
        const flat = raw === 'MCP_TIMEOUT' ? '工具调用超时' : flattenMcpError(raw);
        return {
          content: `MCP 工具 ${mcpTool.name} 调用失败：${flat}\n提示：若你要操作的是本地文件/代码，请改用内置工具（read_file/grep/glob/edit_file/bash），不要重试本工具。`,
          isError: true,
        };
      }
      // MCP content 数组 → ECode 纯文本（取 text 类型的 text 字段拼接）
      const textParts = result.content
        ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text) ?? [];
      const rawText = textParts.join('\n');
      const isError = result.isError ?? false;
      if (isError && rawText) {
        const flat = flattenMcpError(rawText);
        return {
          content: `MCP 工具 ${mcpTool.name} 失败：${flat}\n提示：若你要操作的是本地文件/代码，请改用内置工具（read_file/grep/glob/edit_file/bash），不要重试本工具。`,
          isError: true,
        };
      }
      return { content: rawText, isError };
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
      } catch {
        // prompt 获取失败静默降级（不污染终端）
      }
    },
  };
}
