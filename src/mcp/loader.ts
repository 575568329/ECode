// MCP（支点 10）loader —— 启动时加载 MCP server 连接 + 合并工具/命令。
//
// 职责：读 registry → 过滤 enabled → 并行 connectMcpServer → 收集 tools/prompts/connections。
// 调用方（use-agent-stream / index.ts）拿到结果后合并进 RunAgentStreamOptions.tools 即可。
// 退出时调用 unloadMcpServers 清理子进程 + 注销动态斜杠命令。
//
// 设计：
//   - 失败不 crash：单个 server 连接失败 → warn + 跳过（对齐 client.ts 行为）。
//   - 并行连接：Promise.all（MCP server 启动是独立的 I/O 操作）。
//   - 超时保护：单个 server 连接不设超时（SDK 内部有超时；配置错误导致卡住的 server 依赖 SDK 处理）。
import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { loadMcpRegistry } from './registry.js';
import { connectMcpServer, disconnectAll, type McpConnection } from './client.js';
import type { ConnectOptions } from './client.js';

/** MCP loader 加载结果（调用方合并进 agent tools 即可） */
export interface McpLoadResult {
  /** 所有成功连接的 server 适配后的工具（追加到内置 toolDefinitions 后面） */
  tools: ToolDefinition[];
  /** 所有连接（含 failed——调用方不需要区分，退出时统一 disconnectAll） */
  connections: McpConnection[];
  /** 所有 server 的 prompts 汇总（每个带 serverName，供注册斜杠命令用） */
  prompts: Array<{ serverName: string; prompt: Prompt }>;
}

/**
 * 加载并连接所有 enabled 的 MCP server。
 *
 * 流程：loadMcpRegistry → filter(enabled) → Promise.all(connectMcpServer) → 收集 tools。
 * registry 加载失败 / 无 enabled server → 返回空结果（降级不 crash）。
 *
 * @param opts.connectOptions 透传给 connectMcpServer（测试注入 mock SDK 用）
 * @param opts.dataDir 显式数据目录（测试用）
 */
export async function loadMcpServers(opts?: {
  connectOptions?: ConnectOptions;
  dataDir?: string;
}): Promise<McpLoadResult> {
  const entries = loadMcpRegistry({ dataDir: opts?.dataDir });
  const enabled = entries.filter((e) => e.enabled);
  if (enabled.length === 0) {
    return { tools: [], connections: [], prompts: [] };
  }

  // 并行连接所有 enabled server
  const connections = await Promise.all(
    enabled.map((entry) => connectMcpServer(entry, opts?.connectOptions)),
  );

  // 收集所有 connected server 的工具和 prompts
  const tools = connections.flatMap((c) => c.tools);
  const prompts = connections.flatMap((c) =>
    c.prompts.map((p) => ({ serverName: c.serverName, prompt: p })),
  );

  // 日志摘要
  const connected = connections.filter((c) => c.status === 'connected');
  const failed = connections.filter((c) => c.status === 'failed');
  if (connected.length > 0) {
    console.log(`[MCP] 已连接 ${connected.length} 个 server（${tools.length} 个工具，${prompts.length} 个 prompts）`);
  }
  if (failed.length > 0) {
    console.warn(`[MCP] ${failed.length} 个 server 连接失败`);
  }

  return { tools, connections, prompts };
}

/**
 * 断开所有 MCP 连接（进程退出时调用）。
 * 透传 disconnectAll，语义更明确。
 */
export { disconnectAll as unloadMcpServers };
