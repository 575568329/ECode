// MCP（支点 10）client —— server 连接生命周期 + stdio RCE 命令白名单 + 30s 连接超时。
//
// 支持 stdio（本地子进程）和 http（Streamable HTTP 远程 server）两种 transport。
// 安全红线（10-T7）：stdio server 通过 child_process.spawn 启动，
// registry.json 若被篡改可导致任意命令执行（RCE，OX Security CVE，150M+ 下载量）。
// 本模块在 spawn 前校验命令头是否在安全白名单内。
// http transport 无 spawn 风险（无 RCE 面），仅需 url 和 headers 校验。
//
// 设计（决策 #003 红线 10-T7 + M5-MCP管理增强详设 §4）：
//   - 命令头白名单（SAFE_COMMAND_HEADS）：只允许已知安全的可执行文件 basename（仅 stdio）。
//   - 只校验 command 不校验 args/env：SDK StdioClientTransport 用 spawn(command, args)（数组传参不经 shell）。
//   - 依赖注入：SDK 工厂 + 超时 通过 opts 注入（测试 mock）。
//   - 30s 连接超时（raceWithTimeout）：修盲区——配错的 server 不会卡死 agent 启动（对齐 claude/opencode）。
//   - 超时兜底：raceWithTimeout 内对主 promise 挂静默 catch，防超时后后台 reject → unhandledRejection 崩进程。
//   - lastError：failedConn(reason) 携带失败原因，供 /mcp 回显（超越 claude）。
//   - pid：McpConnection.pid 暴露 stdio child pid（SDK transport.pid），供 manager 进程树清理用。
//   - 失败不 crash：校验/连接/listTools 失败 → warn + 返回 failed 状态（带 lastError）。
import { basename } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as McpTool, Prompt as McpPrompt, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { McpRegistryEntry } from './registry.js';
import { adaptMcpTool } from './adapter.js';

// ---- RCE 命令白名单 ----

/**
 * stdio 允许的命令头白名单（安全可执行文件 basename，已 strip .exe 后缀）。
 * 覆盖 99% 真实 MCP server 的运行时入口（17 个）。
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
 *   2. 提取 basename（处理路径）+ strip .exe 后缀（Windows）+ strip 版本号（python3.12 → python3）
 *   3. basename 是否在 SAFE_COMMAND_HEADS 中
 *
 * @returns safe=true 表示允许 spawn；safe=false 表示拒绝（含 reason 供日志）。
 */
export function validateMcpCommand(command: string | undefined): { safe: boolean; reason?: string } {
  if (!command || command.trim() === '') {
    return { safe: false, reason: 'MCP server 命令为空' };
  }
  const base = basename(command).replace(/\.exe$/i, '').replace(/\.\d+$/, '');
  if (!SAFE_COMMAND_HEADS.has(base)) {
    return { safe: false, reason: `MCP server 命令 "${base}" 不在白名单中` };
  }
  return { safe: true };
}

// ---- 连接超时 ----

/** MCP 单 server 连接超时（对齐 claude/opencode 30s）。测试可经 opts.timeoutMs 注入小值。 */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;

/**
 * 给 Promise 套超时；超时调 onTimeout 清理资源。
 *
 * 🔴 关键（详设 §4.1）：超时后主 promise 仍在后台跑（SDK 可能已建 socket/注册 listeners），
 * 若后续 reject 无人接 → unhandledRejection 崩进程。这里对 p 挂静默 catch 兜底，
 * 保证后台 reject 有 handler（不崩进程），又不影响 race 结果（race 已由 timeout 决出）。
 */
export function raceWithTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Promise<void>): Promise<T> {
  p.catch(() => {}); // 静默兜底：防超时后主 promise 后台 reject 触发 unhandledRejection
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('MCP_TIMEOUT')), ms);
  });
  return Promise.race([p, timeout])
    .finally(() => {
      if (timer) clearTimeout(timer);
    })
    .catch(async (e) => {
      if (e instanceof Error && e.message === 'MCP_TIMEOUT') {
        await onTimeout(); // 超时→清理 transport
        throw e;
      }
      throw e; // 非超时错误透传
    });
}

// ---- 连接类型 ----

export type McpConnectionStatus = 'disconnected' | 'connected' | 'failed';

export interface McpConnection {
  readonly serverName: string;
  status: McpConnectionStatus;
  readonly tools: ToolDefinition[];
  /** server 暴露的 prompts（listPrompts 获取，用于注册斜杠命令）。 */
  readonly prompts: McpPrompt[];
  /** stdio child pid（SDK transport.pid，供 manager 进程树清理用）；http transport 为 null。 */
  readonly pid: number | null;
  /** failed 时的失败原因（RCE/spawn/超时/listTools 等，供 /mcp 回显）。connected 时 undefined。 */
  readonly lastError?: string;
  /** 获取指定 prompt 的消息（供斜杠命令 execute 回调调用）。 */
  getPrompt(name: string, args?: Record<string, string>): Promise<{ messages: unknown[] }>;
  disconnect(): Promise<void>;
}

// ---- SDK 依赖注入类型（测试时传 mock）----

/** SDK Transport 接口（最小契约：start/close/send——connect 需要 Transport 类型） */
interface TransportLike {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
}

/** SDK Client 接口（最小契约：connect/listTools/callTool/listPrompts/getPrompt） */
interface ClientLike {
  connect(transport: TransportLike): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  listPrompts(): Promise<{ prompts: McpPrompt[] }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{ messages: unknown[] }>;
}

// ---- 连接生命周期 ----

/** connectMcpServer 可选依赖注入（测试时传 mock，生产缺省用真实 SDK） */
export interface ConnectOptions {
  createTransport?: (params: { command: string; args?: string[]; env?: Record<string, string> }) => TransportLike;
  createClient?: () => ClientLike;
  /** http transport 工厂（测试注入 mock）。生产缺省用 SDK StreamableHTTPClientTransport。 */
  createHttpTransport?: (params: { url: string; headers?: Record<string, string> }) => TransportLike;
  /** 连接超时（ms），测试注入小值；默认 MCP_CONNECT_TIMEOUT_MS（30s）。 */
  timeoutMs?: number;
}

/**
 * 连接单个 MCP server（stdio 或 http）。
 *
 * 流程：前置校验 → 创建 transport（stdio: RCE 校验 / http: url 校验）→ connect（30s 超时）→ listTools（30s 超时）→ adapt。
 * 任何一步失败 → warn + 返回带 lastError 的 failed 状态（不 crash agent）。
 */
export async function connectMcpServer(
  entry: McpRegistryEntry,
  opts?: ConnectOptions,
): Promise<McpConnection> {
  const timeoutMs = opts?.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;

  /** 构造 failed 连接（带原因，供 /mcp 回显）。 */
  const failedConn = (reason: string): McpConnection => ({
    serverName: entry.name,
    status: 'failed',
    tools: [],
    prompts: [],
    pid: null,
    lastError: reason,
    getPrompt: async () => ({ messages: [] }),
    disconnect: async () => {},
  });

  // 前置校验：只支持 stdio / http + enabled
  if (!entry.enabled) {
    return failedConn('server 已禁用');
  }
  if (entry.transport !== 'stdio' && entry.transport !== 'http') {
    return failedConn(`不支持的 transport: ${entry.transport}`);
  }

  // ---- 创建 transport（stdio 和 http 分道，后续 connect→listTools→adapt 完全复用）----
  let transport: TransportLike;
  if (entry.transport === 'stdio') {
    // stdio：RCE 命令白名单校验（安全红线）
    const validation = validateMcpCommand(entry.command);
    if (!validation.safe) {
      console.warn(`[MCP] ${entry.name}: ${validation.reason}，跳过连接`);
      return failedConn(validation.reason!);
    }
    const createTransport = opts?.createTransport ?? ((params) => new StdioClientTransport(params));
    transport = createTransport({ command: entry.command!, args: entry.args, env: entry.env });
  } else {
    // http（Streamable HTTP）：校验 url
    if (!entry.url) {
      console.warn(`[MCP] ${entry.name}: http transport 缺少 url，跳过连接`);
      return failedConn('http transport 缺少 url');
    }
    const createHttpTransport = opts?.createHttpTransport ?? ((params) => {
      const url = new URL(params.url);
      const httpOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = params.headers
        ? { requestInit: { headers: params.headers } }
        : {};
      return new StreamableHTTPClientTransport(url, httpOpts);
    });
    transport = createHttpTransport({ url: entry.url, headers: entry.headers });
  }

  // SDK 工厂（生产默认用真实 SDK，测试注入 mock）
  const createClient = opts?.createClient ?? (() => new Client({ name: 'ecode', version: '0.1.0' }));
  const client = createClient();

  // connect 套 30s 超时（超时→清理 transport）
  try {
    await raceWithTimeout(client.connect(transport), timeoutMs, async () => {
      await transport.close().catch(() => {});
    });
  } catch (err) {
    const reason = isTimeout(err) ? '连接超时' : `连接失败: ${errMessage(err)}`;
    console.warn(`[MCP] ${entry.name}: ${reason}`);
    await transport.close().catch(() => {}); // 清理，忽略二次错误
    return failedConn(reason);
  }

  // listTools 套 30s 超时
  let tools: ToolDefinition[];
  try {
    const result = await raceWithTimeout(client.listTools(), timeoutMs, async () => {});
    tools = result.tools.map((t) =>
      adaptMcpTool(entry.name, t, (name, args) =>
        client.callTool({ name, arguments: args }) as Promise<CallToolResult>),
    );
  } catch (err) {
    const reason = isTimeout(err) ? '获取工具超时' : `获取工具失败: ${errMessage(err)}`;
    console.warn(`[MCP] ${entry.name}: ${reason}`);
    await transport.close().catch(() => {});
    return failedConn(reason);
  }

  // 获取 server 暴露的 prompts（套超时；失败降级空 prompts，不阻断已建立的连接）
  let prompts: McpPrompt[] = [];
  try {
    const promptResult = await raceWithTimeout(client.listPrompts(), timeoutMs, async () => {});
    prompts = promptResult.prompts ?? [];
  } catch {
    // listPrompts 失败降级为空 prompts（不阻断已建立的连接）
  }

  // stdio child pid（SDK StdioClientTransport.pid getter，stdio.js:126）；http transport 无 pid
  const pid = (transport as { pid?: number | null }).pid ?? null;

  // 构建可变连接对象
  let status: McpConnectionStatus = 'connected';
  const connection: McpConnection = {
    serverName: entry.name,
    get status() { return status; },
    tools,
    prompts,
    pid,
    getPrompt: async (name, args) => {
      try {
        return await client.getPrompt({ name, arguments: args });
      } catch (err) {
        console.warn(`[MCP] ${entry.name}: getPrompt("${name}") 失败 (${errMessage(err)})`);
        return { messages: [] };
      }
    },
    disconnect: async () => {
      await transport.close().catch(() => {});
      status = 'disconnected';
    },
  };

  return connection;
}

/** 判断错误是否为 raceWithTimeout 抛的超时。 */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'MCP_TIMEOUT';
}

/** 统一错误信息提取（避免散落的 instanceof Error 三元）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 批量断开所有 MCP 连接（进程退出时调用）。
 * 忽略单个连接的错误，保证全部尝试断开。
 */
export async function disconnectAll(connections: McpConnection[]): Promise<void> {
  await Promise.all(connections.map((c) => c.disconnect().catch(() => {})));
}
