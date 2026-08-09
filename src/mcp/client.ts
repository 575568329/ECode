// MCP（支点 10）client —— stdio server 连接生命周期 + RCE 命令白名单。
//
// 安全红线（10-T7）：MCP server 通过 child_process.spawn 启动，
// registry.json 若被篡改可导致任意命令执行（RCE，OX Security CVE，150M+ 下载量）。
// 本模块在 spawn 前校验命令头是否在安全白名单内。
//
// 设计（决策 #003 红线 10-T7）：
//   - 命令头白名单（SAFE_COMMAND_HEADS）：只允许已知安全的可执行文件 basename。
//   - 只校验 command 不校验 args/env：
//     SDK StdioClientTransport 内部用 spawn(command, args)（数组传参不经 shell 解释），
//     args 无注入风险；shell 本身被白名单拦截。
//   - 依赖注入：SDK 工厂通过 opts 注入（对齐 validation.ts runCmd / runner.ts exec），测试时传 mock。
//   - 失败不 crash：校验/连接/listTools 失败 → warn + 返回 failed 状态。
import { basename } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as McpTool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { McpRegistryEntry } from './registry.js';
import { adaptMcpTool } from './adapter.js';

// ---- RCE 命令白名单 ----

/**
 * stdio 允许的命令头白名单（安全可执行文件 basename，已 strip .exe 后缀）。
 * 覆盖 99% 真实 MCP server 的运行时入口。
 * 新增须经安全审阅（红线 10-T7）。
 */
const SAFE_COMMAND_HEADS: ReadonlySet<string> = new Set([
  // Node.js 生态（主力）
  'npx', 'npm', 'node',
  // Python 生态
  'python', 'python3', 'uvx', 'pip', 'pip3',
  // JS 替代运行时
  'deno', 'bun',
  // JVM 生态
  'java', 'javac',
  // .NET 生态
  'dotnet',
  // Go / Rust
  'go', 'cargo',
  // Ruby
  'ruby', 'gem',
]);

/**
 * 校验 MCP server 启动命令是否在安全白名单内（纯函数，可独立测试）。
 *
 * 校验逻辑：
 *   1. 空命令 → unsafe
 *   2. 提取 basename（处理路径）+ strip .exe 后缀（Windows）
 *   3. basename 是否在 SAFE_COMMAND_HEADS 中
 *
 * @returns safe=true 表示允许 spawn；safe=false 表示拒绝（含 reason 供日志）。
 */
export function validateMcpCommand(command: string | undefined): { safe: boolean; reason?: string } {
  if (!command || command.trim() === '') {
    return { safe: false, reason: 'MCP server 命令为空' };
  }
  // 提取 basename + strip .exe（Windows: node.exe → node）+ strip 版本号后缀（python3.12 → python3）
  const base = basename(command).replace(/\.exe$/i, '').replace(/\.\d+$/, '');
  if (!SAFE_COMMAND_HEADS.has(base)) {
    return { safe: false, reason: `MCP server 命令 "${base}" 不在白名单中` };
  }
  return { safe: true };
}

// ---- 连接类型 ----

export type McpConnectionStatus = 'disconnected' | 'connected' | 'failed';

export interface McpConnection {
  readonly serverName: string;
  status: McpConnectionStatus;
  readonly tools: ToolDefinition[];
  disconnect(): Promise<void>;
}

// ---- SDK 依赖注入类型（测试时传 mock）----

/** SDK Transport 接口（最小契约：start/close/send——connect 需要 Transport 类型） */
interface TransportLike {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
}

/** SDK Client 接口（最小契约：connect/listTools/callTool） */
interface ClientLike {
  connect(transport: TransportLike): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
}

// ---- 连接生命周期 ----

/** connectMcpServer 可选依赖注入（测试时传 mock，生产缺省用真实 SDK） */
export interface ConnectOptions {
  createTransport?: (params: { command: string; args?: string[]; env?: Record<string, string> }) => TransportLike;
  createClient?: () => ClientLike;
}

/**
 * 连接单个 MCP server（stdio）。
 *
 * 流程：RCE 校验 → 创建 transport → connect → listTools → adapt。
 * 任何一步失败 → warn + 返回 failed 状态（不 crash agent）。
 */
export async function connectMcpServer(
  entry: McpRegistryEntry,
  opts?: ConnectOptions,
): Promise<McpConnection> {
  // 前置校验：只支持 stdio + enabled
  if (entry.transport !== 'stdio' || !entry.enabled) {
    return { serverName: entry.name, status: 'failed', tools: [], disconnect: async () => {} };
  }

  // RCE 命令白名单校验（安全红线）
  const validation = validateMcpCommand(entry.command);
  if (!validation.safe) {
    console.warn(`[MCP] ${entry.name}: ${validation.reason}，跳过连接`);
    return { serverName: entry.name, status: 'failed', tools: [], disconnect: async () => {} };
  }

  // SDK 工厂（生产默认用真实 SDK，测试注入 mock）
  const createTransport = opts?.createTransport ?? ((params) => new StdioClientTransport(params));
  const createClient = opts?.createClient ?? (() => new Client({ name: 'ecode', version: '0.1.0' }));

  const transport = createTransport({ command: entry.command!, args: entry.args, env: entry.env });
  const client = createClient();

  try {
    await client.connect(transport);
  } catch (err) {
    console.warn(`[MCP] ${entry.name}: 连接失败 (${err instanceof Error ? err.message : String(err)})`);
    await transport.close().catch(() => {}); // 清理，忽略二次错误
    return { serverName: entry.name, status: 'failed', tools: [], disconnect: async () => {} };
  }

  let tools: ToolDefinition[];
  try {
    const result = await client.listTools();
    // callTool 闭包捕获 client 引用（ClientLike 已包含 callTool 方法）
    // SDK callTool 返回联合类型（正常/任务），adaptMcpTool 只需 CallToolResult，用断言收窄
    tools = result.tools.map((t) =>
      adaptMcpTool(entry.name, t, (name, args) =>
        client.callTool({ name, arguments: args }) as Promise<CallToolResult>),
    );
  } catch (err) {
    console.warn(`[MCP] ${entry.name}: 获取工具列表失败 (${err instanceof Error ? err.message : String(err)})`);
    await transport.close().catch(() => {});
    return { serverName: entry.name, status: 'failed', tools: [], disconnect: async () => {} };
  }

  // 构建可变连接对象
  let status: McpConnectionStatus = 'connected';
  const connection: McpConnection = {
    serverName: entry.name,
    get status() { return status; },
    tools,
    disconnect: async () => {
      await transport.close().catch(() => {});
      status = 'disconnected';
    },
  };

  return connection;
}

/**
 * 批量断开所有 MCP 连接（进程退出时调用）。
 * 忽略单个连接的错误，保证全部尝试断开。
 */
export async function disconnectAll(connections: McpConnection[]): Promise<void> {
  await Promise.all(connections.map((c) => c.disconnect().catch(() => {})));
}
