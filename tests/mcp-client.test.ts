// 阶段3 MCP：client.ts RCE allowlist + 连接生命周期测试。
// 重点测 validateMcpCommand 命令白名单纯函数 + connectMcpServer 生命周期。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateMcpCommand, connectMcpServer, disconnectAll } from '../src/mcp/client.js';
import type { McpConnection } from '../src/mcp/client.js';
import type { McpRegistryEntry } from '../src/mcp/registry.js';

// ---- validateMcpCommand 纯函数测试 ----

describe('validateMcpCommand（RCE 命令白名单）', () => {
  it('白名单命中：npx', () => {
    expect(validateMcpCommand('npx').safe).toBe(true);
  });

  it('白名单命中：node', () => {
    expect(validateMcpCommand('node').safe).toBe(true);
  });

  it('白名单命中：python3', () => {
    expect(validateMcpCommand('python3').safe).toBe(true);
  });

  it('白名单命中：uvx', () => {
    expect(validateMcpCommand('uvx').safe).toBe(true);
  });

  it('白名单命中：deno', () => {
    expect(validateMcpCommand('deno').safe).toBe(true);
  });

  it('白名单命中：bun', () => {
    expect(validateMcpCommand('bun').safe).toBe(true);
  });

  it('白名单命中：java', () => {
    expect(validateMcpCommand('java').safe).toBe(true);
  });

  it('白名单命中：cargo', () => {
    expect(validateMcpCommand('cargo').safe).toBe(true);
  });

  it('路径提取：/usr/bin/node → safe', () => {
    expect(validateMcpCommand('/usr/bin/node').safe).toBe(true);
  });

  it('路径提取：C:\\nodejs\\node.exe → safe（跨平台 .exe strip）', () => {
    expect(validateMcpCommand('C:\\nodejs\\node.exe').safe).toBe(true);
  });

  it('路径提取：/usr/local/bin/python3.12 → safe', () => {
    expect(validateMcpCommand('/usr/local/bin/python3.12').safe).toBe(true);
  });

  it('空命令 undefined → unsafe', () => {
    const r = validateMcpCommand(undefined);
    expect(r.safe).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it('空命令 空串 → unsafe', () => {
    const r = validateMcpCommand('');
    expect(r.safe).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it('非法命令 rm → unsafe', () => {
    const r = validateMcpCommand('rm');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('不在白名单');
  });

  it('shell /bin/sh → unsafe', () => {
    const r = validateMcpCommand('/bin/sh');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('不在白名单');
  });

  it('shell bash → unsafe', () => {
    const r = validateMcpCommand('bash');
    expect(r.safe).toBe(false);
  });

  it('网络工具 curl → unsafe', () => {
    const r = validateMcpCommand('curl');
    expect(r.safe).toBe(false);
  });

  it('网络工具 wget → unsafe', () => {
    const r = validateMcpCommand('wget');
    expect(r.safe).toBe(false);
  });

  it('路径遍历 ../malicious → unsafe', () => {
    const r = validateMcpCommand('../malicious');
    expect(r.safe).toBe(false);
  });

  it('相对路径 ./my-script → unsafe', () => {
    const r = validateMcpCommand('./my-script');
    expect(r.safe).toBe(false);
  });
});

// ---- connectMcpServer 生命周期测试 ----

/** 创建用于测试的 mock SDK 工厂 */
function createMockFactories(opts?: {
  tools?: Array<{ name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } }>;
  connectError?: Error;
  listToolsError?: Error;
}) {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockTransport = {
    start: vi.fn().mockResolvedValue(undefined),
    close: mockClose,
    send: vi.fn().mockResolvedValue(undefined),
  };
  const mockClient = {
    connect: vi.fn().mockImplementation(async () => {
      if (opts?.connectError) throw opts.connectError;
    }),
    listTools: vi.fn().mockImplementation(async () => {
      if (opts?.listToolsError) throw opts.listToolsError;
      return { tools: opts?.tools ?? [{ name: 'search', inputSchema: { type: 'object', properties: {}, required: [] } }] };
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'mock result' }] }),
  };
  return {
    mockTransport,
    mockClient,
    createTransport: vi.fn().mockReturnValue(mockTransport),
    createClient: vi.fn().mockReturnValue(mockClient),
  };
}

describe('connectMcpServer（连接生命周期）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  it('正常连接 → status=connected, tools 非空', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'test-server', transport: 'stdio', command: 'npx', args: ['-y', 'test-mcp'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0].name).toBe('mcp__test-server__search');
    expect(mocks.createTransport).toHaveBeenCalledWith({ command: 'npx', args: ['-y', 'test-mcp'] });
  });

  it('RCE 校验失败 → status=failed, transport 未创建', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'evil', transport: 'stdio', command: 'rm', args: ['-rf', '/'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(conn.tools).toHaveLength(0);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('transport start（connect）抛错 → status=failed, close 已调', async () => {
    const mocks = createMockFactories({ connectError: new Error('spawn ENOENT') });
    const entry: McpRegistryEntry = {
      name: 'bad', transport: 'stdio', command: 'node', args: ['server.js'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(mocks.mockTransport.close).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('listTools 抛错 → status=failed, close 已调', async () => {
    const mocks = createMockFactories({ listToolsError: new Error('server crashed') });
    const entry: McpRegistryEntry = {
      name: 'unstable', transport: 'stdio', command: 'python', args: ['-m', 'mcp'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(mocks.mockTransport.close).toHaveBeenCalled();
  });

  it('空 command → status=failed', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'empty', transport: 'stdio', command: undefined, enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('非 stdio transport → status=failed（阶段 1 只支持 stdio）', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'http-server', transport: 'http', enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it('disabled → status=failed', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'off', transport: 'stdio', command: 'npx', enabled: false,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
  });

  it('disconnect → close 已调, status=disconnected', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'disc', transport: 'stdio', command: 'node', enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    await conn.disconnect();
    expect(conn.status).toBe('disconnected');
    expect(mocks.mockTransport.close).toHaveBeenCalledTimes(1);
  });
});

describe('disconnectAll', () => {
  it('批量断开所有连接', async () => {
    const mocks1 = createMockFactories();
    const mocks2 = createMockFactories();
    const entry: McpRegistryEntry = { name: 'a', transport: 'stdio', command: 'node', enabled: true };
    const conn1 = await connectMcpServer(entry, { createTransport: mocks1.createTransport, createClient: mocks1.createClient });
    const conn2 = await connectMcpServer(entry, { createTransport: mocks2.createTransport, createClient: mocks2.createClient });
    await disconnectAll([conn1, conn2]);
    expect(conn1.status).toBe('disconnected');
    expect(conn2.status).toBe('disconnected');
    expect(mocks1.mockTransport.close).toHaveBeenCalledTimes(1);
    expect(mocks2.mockTransport.close).toHaveBeenCalledTimes(1);
  });

  it('空数组不报错', async () => {
    await expect(disconnectAll([])).resolves.toBeUndefined();
  });
});
