// MCP（支点 10）manager —— 连接池 + 互斥锁 + 生命周期 + 状态查询 + onChange（详设 §3.2/§4/§5）。
//
// 核心不变式：pool 是所有状态查询的唯一来源（/mcp 显示 + agent 工具表数据源）。
//   - disabled/disconnected/failed 态 connection=null（pool 类型闭合，不持有失败连接）。
//   - connect/reconnect/disconnect 对同一 server 串行（withLock 互斥锁，防并发 spawn 乱飞）。
//   - onChange 仅终态 emit（connecting/disconnecting 锁内瞬态不 emit，防 syncPrompts 抖动）。
//   - disconnect/reconnect/disconnectAll 含进程树清理（SDK close + win32 taskkill 兜底）。
import type { Prompt as McpPrompt } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { McpRegistryEntry } from './registry.js';
import { loadMcpRegistry } from './registry.js';
import { connectMcpServer, type McpConnection, type ConnectOptions } from './client.js';
import { killProcessTree } from './process-cleanup.js';

/** 单个 server 运行时状态（/mcp 显示 + agent 工具表数据源）。 */
export interface McpServerState {
  name: string;
  status: 'connected' | 'failed' | 'disconnected' | 'disabled';
  transport: 'stdio' | 'http';
  tools: ToolDefinition[];
  prompts: McpPrompt[];
  /** failed 时的失败原因（/mcp 回显）。connected 时 undefined。 */
  lastError?: string;
  /** 原始配置（info/add/remove 用）。 */
  entry: McpRegistryEntry;
}

/** 连接池项：connection 可空（disabled/disconnected/failed 态）。 */
interface PoolItem {
  connection: McpConnection | null;
  state: McpServerState;
}

type McpChangeListener = () => void;

/** McpManager 构造选项（测试注入）。 */
export interface McpManagerOptions {
  /** 连接工厂（测试注入 mock）；默认 connectMcpServer。 */
  connectMcpServer?: typeof connectMcpServer;
  /** 透传给连接工厂（超时/mock SDK）。 */
  connectOptions?: ConnectOptions;
  /** 数据目录（测试用）；默认 resolveDataDir。 */
  dataDir?: string;
}

export class McpManager {
  private pool = new Map<string, PoolItem>();
  private listeners = new Set<McpChangeListener>();
  private locks = new Map<string, Promise<void>>();
  private readonly connectFn: typeof connectMcpServer;
  private readonly connectOptions?: ConnectOptions;
  private readonly dataDir?: string;

  constructor(opts: McpManagerOptions = {}) {
    this.connectFn = opts.connectMcpServer ?? connectMcpServer;
    this.connectOptions = opts.connectOptions;
    this.dataDir = opts.dataDir;
  }

  /** 互斥锁：同一 server 的 connect/reconnect/disconnect 串行（防并发 spawn 乱飞，详设 §4.5）。 */
  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const result = prev.then(() => fn());
    // 锁 gate：result settle（无论成败）后释放；gate 永不 reject → 下一轮 prev 永远 resolve
    this.locks.set(name, result.then(() => undefined, () => undefined));
    return result;
  }

  /** 终态变更通知（syncPrompts 重注册斜杠命令）。 */
  private emitChange(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listener 异常不影响 manager（防御，不崩进程）
      }
    }
  }

  private loadEntryFromRegistry(name: string): McpRegistryEntry | undefined {
    return loadMcpRegistry({ dataDir: this.dataDir }).find((e) => e.name === name);
  }

  /** 核心连接：调 connectFn → 更新 pool → emit（终态）。 */
  private async connectOne(entry: McpRegistryEntry): Promise<McpServerState> {
    if (!entry.enabled) {
      const state: McpServerState = {
        name: entry.name, status: 'disabled', transport: entry.transport,
        tools: [], prompts: [], entry,
      };
      this.pool.set(entry.name, { connection: null, state });
      this.emitChange();
      return state;
    }
    const conn = await this.connectFn(entry, this.connectOptions);
    const connected = conn.status === 'connected';
    const state: McpServerState = {
      name: entry.name,
      status: connected ? 'connected' : 'failed',
      transport: entry.transport,
      tools: connected ? conn.tools : [],
      prompts: connected ? conn.prompts : [],
      lastError: conn.lastError,
      entry,
    };
    // failed 连接不持有（connection=null），避免泄漏；其 disconnect 是 no-op
    this.pool.set(entry.name, { connection: connected ? conn : null, state });
    this.emitChange();
    return state;
  }

  /** 启动：读 registry → 全入 pool（enabled→connected/failed，disabled→disabled）。 */
  async connectAll(): Promise<void> {
    const entries = loadMcpRegistry({ dataDir: this.dataDir });
    await Promise.all(entries.map((entry) => this.connect(entry.name, entry)));
  }

  /** 连接指定 server（entry 可选，缺省从 pool/registry 取）。 */
  async connect(name: string, entry?: McpRegistryEntry): Promise<McpServerState> {
    return this.withLock(name, async () => {
      const e = entry ?? this.pool.get(name)?.state.entry ?? this.loadEntryFromRegistry(name);
      if (!e) throw new Error(`MCP server "${name}" 不存在`);
      return this.connectOne(e);
    });
  }

  /** 重连 = 测试连通：断旧（含进程清理）→ 重建（带超时）。失败也返回 state（带 lastError）。 */
  async reconnect(name: string): Promise<McpServerState> {
    return this.withLock(name, async () => {
      const item = this.pool.get(name);
      const entry = item?.state.entry ?? this.loadEntryFromRegistry(name);
      if (!entry) throw new Error(`MCP server "${name}" 不存在`);
      // 1. 清理旧连接（拿pid→SDK close→taskkill兜底，确保孙子进程被杀，详设 §5.3）
      if (item?.connection) {
        const pid = item.connection.pid;
        await item.connection.disconnect();
        await killProcessTree(pid);
      }
      // 2. 重建
      return this.connectOne(entry);
    });
  }

  /** 断开指定 server（SDK close + win32 taskkill 兜底）。 */
  async disconnect(name: string): Promise<void> {
    await this.withLock(name, async () => {
      const item = this.pool.get(name);
      if (!item?.connection) return;
      const pid = item.connection.pid;
      await item.connection.disconnect();
      await killProcessTree(pid);
      item.connection = null;
      item.state.status = 'disconnected';
      item.state.tools = [];
      item.state.prompts = [];
      this.emitChange();
    });
  }

  /** 退出清理（幂等：disconnect 内 connection=null 检查兜底；StrictMode 双 mount remount 后能重连）。 */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((name) => this.disconnect(name)));
  }

  /** registry 变化后同步：新增 connect / 删除 disconnect+forget；已存在不动（改配置用 reconnect）。 */
  async reload(): Promise<void> {
    const entries = loadMcpRegistry({ dataDir: this.dataDir });
    const entryMap = new Map(entries.map((e) => [e.name, e]));
    // registry 中已不存在的 → disconnect + 移出 pool
    await Promise.all(
      [...this.pool.keys()]
        .filter((name) => !entryMap.has(name))
        .map((name) => this.disconnect(name).then(() => {
          this.pool.delete(name);
        })),
    );
    // 仅 connect pool 中没有的（新增）；已存在的不动（改配置走 reconnect，避免全量重连 spawn）
    await Promise.all(
      entries.filter((e) => !this.pool.has(e.name)).map((entry) => this.connect(entry.name, entry)),
    );
  }

  /** 从 pool 移除（registry 已删条目后调用；配合 mcp.remove，不写 registry、不 disconnect）。 */
  forget(name: string): void {
    this.pool.delete(name);
    this.locks.delete(name);
    this.emitChange();
  }

  /** 查询状态：name 指定返回单个（不存在返回 undefined）；缺省返回全部。 */
  getStatus(name?: string): McpServerState | McpServerState[] | undefined {
    if (name !== undefined) return this.pool.get(name)?.state;
    return [...this.pool.values()].map((i) => i.state);
  }

  /** 合并所有 connected server 工具（喂给 agent）。 */
  getAllTools(): ToolDefinition[] {
    return [...this.pool.values()].flatMap((i) => i.state.tools);
  }

  /** 合并所有 connected server prompts（注册斜杠命令用）。 */
  getAllPrompts(): Array<{ serverName: string; prompt: McpPrompt }> {
    const result: Array<{ serverName: string; prompt: McpPrompt }> = [];
    for (const [name, item] of this.pool) {
      for (const prompt of item.state.prompts) {
        result.push({ serverName: name, prompt });
      }
    }
    return result;
  }

  /** 调用指定 server 的 prompt（syncPrompts 注册的斜杠命令用）。 */
  async callPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<{ messages: unknown[] }> {
    const conn = this.pool.get(serverName)?.connection;
    if (!conn) return { messages: [] };
    return conn.getPrompt(promptName, args);
  }

  /** 订阅变更（仅终态触发）；返回 unsubscribe。 */
  onChange(listener: McpChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
