// T3：McpManager 测试 —— 连接池 + 互斥锁 + 生命周期 + 状态查询 + onChange。
// vi.mock process-cleanup（避免测试真调 taskkill 杀进程）；connectMcpServer 经 opts 注入 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMcpRegistry, type McpRegistryEntry } from '../src/mcp/registry.js';
import type { McpConnection } from '../src/mcp/client.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { McpManager, type McpServerState } from '../src/mcp/manager.js';

// mock 进程清理（测试不真杀进程；detectPlatform 强制 posix 走 no-op）
vi.mock('../src/mcp/process-cleanup.js', () => ({
  killProcessTree: vi.fn().mockResolvedValue(undefined),
  detectPlatform: () => 'posix' as const,
}));

import { killProcessTree } from '../src/mcp/process-cleanup.js';
const mockKill = vi.mocked(killProcessTree);

/** 构造 mock McpConnection（connected 或 failed）。 */
function makeConn(name: string, opts: { connected?: boolean; tools?: number } = {}): McpConnection {
  const connected = opts.connected ?? true;
  const toolCount = opts.tools ?? 1;
  const tools: ToolDefinition[] = Array.from({ length: toolCount }, (_, i) => ({
    name: `mcp__${name}__t${i}`,
    description: '',
    parameters: { type: 'object' as const, properties: {}, required: [] },
    dangerous: true,
    execute: async () => ({ content: '', isError: false }),
  }));
  return {
    serverName: name,
    status: connected ? 'connected' : 'failed',
    tools: connected ? tools : [],
    prompts: [],
    pid: connected ? 12345 : null,
    lastError: connected ? undefined : 'mock 失败',
    getPrompt: async () => ({ messages: [] }),
    disconnect: async () => {},
  };
}

/** 构造 mock connectMcpServer（按 behaviors 返回 connected/failed）。 */
function makeConnect(behaviors: Record<string, { connected?: boolean; tools?: number }>) {
  return vi.fn(async (entry: McpRegistryEntry): Promise<McpConnection> =>
    makeConn(entry.name, behaviors[entry.name] ?? {}));
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ecode-mcp-mgr-'));
  mockKill.mockClear();
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeRegistry(entries: McpRegistryEntry[]): void {
  saveMcpRegistry(entries, { dataDir });
}

describe('McpManager connectAll', () => {
  it('enabled→connected / disabled→disabled / failed→failed，全入 pool', async () => {
    writeRegistry([
      { name: 'a', transport: 'stdio', command: 'node', enabled: true },
      { name: 'b', transport: 'stdio', command: 'node', enabled: false },
      { name: 'c', transport: 'stdio', command: 'node', enabled: true },
    ]);
    const m = new McpManager({
      connectMcpServer: makeConnect({ a: { tools: 2 }, c: { connected: false } }),
      dataDir,
    });
    await m.connectAll();
    const status = m.getStatus() as McpServerState[];
    expect(status).toHaveLength(3);
    const byName = Object.fromEntries(status.map((s) => [s.name, s]));
    expect(byName.a.status).toBe('connected');
    expect(byName.b.status).toBe('disabled');
    expect(byName.c.status).toBe('failed');
    expect(byName.c.lastError).toBe('mock 失败');
  });

  it('空 registry → pool 空', async () => {
    const m = new McpManager({ connectMcpServer: makeConnect({}), dataDir });
    await m.connectAll();
    expect(m.getStatus()).toEqual([]);
  });
});

describe('McpManager getAllTools / getAllPrompts', () => {
  it('聚合所有 connected server 工具（failed/disabled 不计）', async () => {
    writeRegistry([
      { name: 'a', transport: 'stdio', command: 'node', enabled: true },
      { name: 'b', transport: 'stdio', command: 'node', enabled: true },
    ]);
    const m = new McpManager({
      connectMcpServer: makeConnect({ a: { tools: 2 }, b: { tools: 3 } }),
      dataDir,
    });
    await m.connectAll();
    expect(m.getAllTools()).toHaveLength(5);
  });
});

describe('McpManager reconnect', () => {
  it('连点两次 → connectFn 串行调用 2 次（互斥锁，非并发 spawn 乱飞）', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const connectFn = makeConnect({ a: { tools: 1 } });
    const m = new McpManager({ connectMcpServer: connectFn, dataDir });
    await Promise.all([m.reconnect('a'), m.reconnect('a')]);
    expect(connectFn).toHaveBeenCalledTimes(2); // 串行各 1 次
  });

  it('reconnect 断旧 → 调 killProcessTree（清理旧 pid）', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 } }), dataDir });
    await m.connect('a'); // 建连接 pid=12345
    mockKill.mockClear();
    await m.reconnect('a');
    expect(mockKill).toHaveBeenCalledWith(12345);
  });
});

describe('McpManager disconnect', () => {
  it('disconnect → status=disconnected, tools 清空, 调 killProcessTree', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 2 } }), dataDir });
    await m.connect('a');
    expect(m.getAllTools()).toHaveLength(2);
    await m.disconnect('a');
    const st = m.getStatus('a') as McpServerState;
    expect(st.status).toBe('disconnected');
    expect(st.tools).toEqual([]);
    expect(m.getAllTools()).toHaveLength(0);
    expect(mockKill).toHaveBeenCalledWith(12345);
  });
});

describe('McpManager onChange', () => {
  it('connect/disconnect 终态触发 listener（仅终态，不抖动）', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 } }), dataDir });
    const listener = vi.fn();
    m.onChange(listener);
    await m.connect('a'); // connected → emit 1
    await m.disconnect('a'); // disconnected → emit 2
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe 后不再触发', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 } }), dataDir });
    const listener = vi.fn();
    const off = m.onChange(listener);
    off();
    await m.connect('a');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('McpManager reload', () => {
  it('新增 connect / 删除 disconnect + 移出 pool', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 }, b: { tools: 1 } }), dataDir });
    await m.connectAll();
    expect((m.getStatus() as McpServerState[]).map((s) => s.name)).toEqual(['a']);
    // registry 改：去掉 a，加 b
    writeRegistry([{ name: 'b', transport: 'stdio', command: 'node', enabled: true }]);
    await m.reload();
    expect((m.getStatus() as McpServerState[]).map((s) => s.name)).toEqual(['b']);
  });
});

describe('McpManager disconnectAll', () => {
  it('幂等：调两次只清理一次（disconnect 内 connection=null 兜底）', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 } }), dataDir });
    await m.connectAll();
    await m.disconnectAll();
    await m.disconnectAll(); // 第二次每个 server connection=null → disconnect no-op
    expect(mockKill).toHaveBeenCalledTimes(1);
  });
});

describe('McpManager forget', () => {
  it('forget → pool 移除，getStatus 不再含', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const m = new McpManager({ connectMcpServer: makeConnect({ a: { tools: 1 } }), dataDir });
    await m.connectAll();
    expect(m.getStatus('a')).toBeDefined();
    m.forget('a');
    expect(m.getStatus('a')).toBeUndefined();
  });
});

describe('McpManager reload（只新增，不重连已存在）', () => {
  it('reload 只 connect 新增 server，已存在的不重连（避免全量 spawn）', async () => {
    writeRegistry([{ name: 'a', transport: 'stdio', command: 'node', enabled: true }]);
    const connectFn = makeConnect({ a: { tools: 1 }, b: { tools: 1 } });
    const m = new McpManager({ connectMcpServer: connectFn, dataDir });
    await m.connectAll();
    expect(connectFn).toHaveBeenCalledTimes(1); // a 连一次
    // registry 加 b（a 仍在）
    writeRegistry([
      { name: 'a', transport: 'stdio', command: 'node', enabled: true },
      { name: 'b', transport: 'stdio', command: 'node', enabled: true },
    ]);
    await m.reload();
    expect(connectFn).toHaveBeenCalledTimes(2); // 只 b 新增连一次，a 不重连
    expect((m.getStatus() as McpServerState[]).map((s) => s.name).sort()).toEqual(['a', 'b']);
  });
});
