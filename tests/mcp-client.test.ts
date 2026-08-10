// 阶段3 MCP：client.ts RCE allowlist + 连接生命周期测试。
// 重点测 validateMcpCommand 命令白名单纯函数 + connectMcpServer 生命周期。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { validateMcpCommand, connectMcpServer, disconnectAll, raceWithTimeout, MCP_CONNECT_TIMEOUT_MS } from '../src/mcp/client.js';
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
  /** 注入 stderr stream,模拟 SDK StdioClientTransport.stderr getter(stderr='pipe' 后返回 PassThrough)。不传 → null(模拟无 stderr 属性的 transport,向后兼容)。 */
  stderrStream?: PassThrough;
  /** 模拟 server 在 connect 过程中往 stderr 写的行(connect mock 写入;挂 listener 已在 connectMcpServer 同步部分完成)。 */
  stderrLines?: string[];
}) {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockTransport = {
    start: vi.fn().mockResolvedValue(undefined),
    close: mockClose,
    send: vi.fn().mockResolvedValue(undefined),
    pid: 12345, // 模拟 SDK StdioClientTransport.pid getter（stdio child pid）
    stderr: opts?.stderrStream ?? null, // 模拟 SDK StdioClientTransport.stderr getter(stderr='pipe' 时返回 stream)
  };
  const mockClient = {
    connect: vi.fn().mockImplementation(async () => {
      // 模拟真实 server 启动往 stderr 写日志(listener 已挂,flowing);写完 await 一次让 nextTick emit flush,再抛错,
      // 否则 connect reject 的 microtask 会抢先于 data emit → stderrLines 还空就被 withStderrTail 读走。
      if (opts?.stderrStream && opts?.stderrLines) {
        for (const line of opts.stderrLines) opts.stderrStream.write(`${line}\n`);
        opts.stderrStream.end();
        await new Promise<void>((r) => process.nextTick(r));
      }
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

  it('正常连接 → status=connected, tools 非空', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = {
      name: 'test-server', transport: 'stdio', command: 'npx', args: ['-y', 'test-mcp'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0].name).toBe('mcp__test-server__search');
    expect(mocks.createTransport).toHaveBeenCalledWith({ command: 'npx', args: ['-y', 'test-mcp'], stderr: 'pipe' });
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
    expect(conn.lastError).toContain('不在白名单');
  });

  it('transport start（connect）抛错 → status=failed, close 已调', async () => {
    const mocks = createMockFactories({ connectError: new Error('spawn ENOENT') });
    const entry: McpRegistryEntry = {
      name: 'bad', transport: 'stdio', command: 'node', args: ['server.js'], enabled: true,
    };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(mocks.mockTransport.close).toHaveBeenCalled();
    expect(conn.lastError).toContain('连接失败');
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

  it('http transport 无 url → status=failed', async () => {
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

// ---- http transport 连接测试 ----

/** 创建 HTTP mock 工厂（createHttpTransport + createClient） */
function createHttpMockFactories(opts?: {
  tools?: Array<{ name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } }>;
  connectError?: Error;
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
    listTools: vi.fn().mockResolvedValue({
      tools: opts?.tools ?? [{ name: 'web_search', inputSchema: { type: 'object', properties: {}, required: [] } }],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'mock result' }] }),
  };
  return {
    mockTransport,
    mockClient,
    createHttpTransport: vi.fn().mockReturnValue(mockTransport),
    createClient: vi.fn().mockReturnValue(mockClient),
  };
}

describe('connectMcpServer（http transport）', () => {

  it('http 正常连接 → status=connected, tools 非空', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = {
      name: 'web-search',
      transport: 'http',
      url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
      headers: { Authorization: 'Bearer test-key' },
      enabled: true,
    };
    const conn = await connectMcpServer(entry, {
      createHttpTransport: mocks.createHttpTransport,
      createClient: mocks.createClient,
    });
    expect(conn.status).toBe('connected');
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0].name).toBe('mcp__web-search__web_search');
    expect(mocks.createHttpTransport).toHaveBeenCalledWith({
      url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
      headers: { Authorization: 'Bearer test-key' },
    });
  });

  it('http transport 缺少 url → status=failed', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = {
      name: 'no-url', transport: 'http', enabled: true,
    };
    const conn = await connectMcpServer(entry, {
      createHttpTransport: mocks.createHttpTransport,
      createClient: mocks.createClient,
    });
    expect(conn.status).toBe('failed');
    expect(mocks.createHttpTransport).not.toHaveBeenCalled();
    expect(conn.lastError).toContain('url');
  });

  it('http 无 headers → 正常连接（headers 可选）', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = {
      name: 'no-auth', transport: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
    };
    const conn = await connectMcpServer(entry, {
      createHttpTransport: mocks.createHttpTransport,
      createClient: mocks.createClient,
    });
    expect(conn.status).toBe('connected');
    expect(mocks.createHttpTransport).toHaveBeenCalledWith({
      url: 'https://example.com/mcp',
      headers: undefined,
    });
  });

  it('http connect 抛错 → status=failed', async () => {
    const mocks = createHttpMockFactories({ connectError: new Error('401 Unauthorized') });
    const entry: McpRegistryEntry = {
      name: 'auth-fail', transport: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
    };
    const conn = await connectMcpServer(entry, {
      createHttpTransport: mocks.createHttpTransport,
      createClient: mocks.createClient,
    });
    expect(conn.status).toBe('failed');
    expect(mocks.mockTransport.close).toHaveBeenCalled();
  });

  it('http disconnect → close 已调, status=disconnected', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = {
      name: 'http-disc', transport: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
    };
    const conn = await connectMcpServer(entry, {
      createHttpTransport: mocks.createHttpTransport,
      createClient: mocks.createClient,
    });
    expect(conn.status).toBe('connected');
    await conn.disconnect();
    expect(conn.status).toBe('disconnected');
    expect(mocks.mockTransport.close).toHaveBeenCalledTimes(1);
  });
});

// ---- T1：raceWithTimeout + 连接超时 + lastError + pid ----

describe('raceWithTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('MCP_CONNECT_TIMEOUT_MS 为 30000（对齐 claude/opencode）', () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it('正常完成（< ms）返回值正确，onTimeout 不触发', async () => {
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    await expect(raceWithTimeout(Promise.resolve('ok'), 1000, onTimeout)).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('超时（> ms）抛 MCP_TIMEOUT + onTimeout 被调', async () => {
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    const p = raceWithTimeout(new Promise(() => { /* 永不 resolve */ }), 100, onTimeout);
    // 同步挂 handler：advance 前挂 expectation，避免 race reject 后到 handler 前的短暂 unhandled 窗口
    const expectation = expect(p).rejects.toThrow('MCP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('超时后主 promise 后台 reject 不触发 unhandledRejection（静默 catch 兜底）', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);
    try {
      // 主 promise 50ms 超时，但其 reject 在 200ms 才发生 → 超时后后台 reject
      const slow = new Promise((_, reject) => { setTimeout(() => reject(new Error('bg')), 200); });
      const p = raceWithTimeout(slow, 50, () => Promise.resolve());
      const expectation = expect(p).rejects.toThrow('MCP_TIMEOUT'); // 同步挂，避免短暂 unhandled 窗口
      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      await vi.advanceTimersByTimeAsync(200); // 触发后台 reject
      await Promise.resolve();
      expect(unhandled).toHaveLength(0); // 有静默 catch → 不崩进程
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

describe('connectMcpServer（超时 + lastError + pid）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('连接超时 → status=failed, lastError 含超时', async () => {
    const mocks = createMockFactories();
    mocks.mockClient.connect.mockImplementation(() => new Promise(() => { /* 永不 resolve */ }));
    const entry: McpRegistryEntry = { name: 'slow', transport: 'stdio', command: 'node', enabled: true };
    const p = connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const conn = await p;
    expect(conn.status).toBe('failed');
    expect(conn.lastError).toContain('超时');
  });

  it('RCE 失败 → lastError 含"不在白名单"', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = { name: 'evil', transport: 'stdio', command: 'rm', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.lastError).toContain('不在白名单');
  });

  it('connect 抛错 → lastError 含"连接失败"', async () => {
    const mocks = createMockFactories({ connectError: new Error('spawn ENOENT') });
    const entry: McpRegistryEntry = { name: 'bad', transport: 'stdio', command: 'node', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.lastError).toContain('连接失败');
  });

  it('listTools 抛错 → lastError 含"获取工具失败"', async () => {
    const mocks = createMockFactories({ listToolsError: new Error('crashed') });
    const entry: McpRegistryEntry = { name: 'u', transport: 'stdio', command: 'python', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.lastError).toContain('获取工具失败');
  });

  it('http 缺 url → lastError 含"url"', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = { name: 'h', transport: 'http', enabled: true };
    const conn = await connectMcpServer(entry, { createHttpTransport: mocks.createHttpTransport, createClient: mocks.createClient });
    expect(conn.lastError).toContain('url');
  });

  it('stdio 连接成功 → pid 非空（SDK transport.pid）', async () => {
    const mocks = createMockFactories();
    const entry: McpRegistryEntry = { name: 's', transport: 'stdio', command: 'node', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    expect(conn.pid).toBe(12345);
  });

  it('http 连接成功 → pid=null（http transport 无子进程）', async () => {
    const mocks = createHttpMockFactories();
    const entry: McpRegistryEntry = { name: 'h', transport: 'http', url: 'https://x.com/mcp', enabled: true };
    const conn = await connectMcpServer(entry, { createHttpTransport: mocks.createHttpTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    expect(conn.pid).toBeNull();
  });
});

// ---- 方案 B：stdio stderr 缓冲回灌诊断 ----
// 修「stderr 默认 inherit → server INFO 日志 + 崩溃堆栈泄到终端污染 ink 画面」：
//   stderr='pipe' 捕获 server stderr → 环形缓冲最近 200 行 → 失败时尾部 8 行拼进 lastError（用户看到 server 真实崩溃原因）。
//   成功时只缓冲不展示（画面干净）。无 stderr 属性的 transport 优雅降级为裸 reason（向后兼容 http / 旧 mock）。
describe('connectMcpServer（stderr 缓冲回灌诊断）', () => {
  it('connect 失败 + stderr 有崩溃输出 → lastError 含「服务端最近输出」+ 崩溃行', async () => {
    const mocks = createMockFactories({
      connectError: new Error('spawn ENOENT'),
      stderrStream: new PassThrough(),
      stderrLines: ['INFO starting', 'Error: Cannot find module ajv', '    at server.js:1'],
    });
    const entry: McpRegistryEntry = { name: 'crash', transport: 'stdio', command: 'node', args: ['s.js'], enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(conn.lastError).toContain('连接失败');
    expect(conn.lastError).toContain('服务端最近输出');
    expect(conn.lastError).toContain('Cannot find module ajv');
  });

  it('connect 成功 + stderr 有 INFO → 不展示（成功无 lastError,stderr 静默缓冲）', async () => {
    const mocks = createMockFactories({
      stderrStream: new PassThrough(),
      stderrLines: ['INFO zai-mcp-server started'],
    });
    const entry: McpRegistryEntry = { name: 'ok', transport: 'stdio', command: 'node', args: ['s.js'], enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('connected');
    expect(conn.lastError).toBeUndefined();
  });

  it('transport 无 stderr 属性（向后兼容/http）→ connect 失败 lastError 仅裸 reason（不拼「服务端最近输出」）', async () => {
    // 不传 stderrStream → mockTransport.stderr=null → 无缓冲,降级裸 reason
    const mocks = createMockFactories({ connectError: new Error('spawn ENOENT') });
    const entry: McpRegistryEntry = { name: 'no-stderr', transport: 'stdio', command: 'node', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(conn.lastError).toContain('连接失败');
    expect(conn.lastError).not.toContain('服务端最近输出');
  });

  it('环形缓冲：stderr 超 200 行 → lastError 只含尾部（早期行被丢弃）', async () => {
    const mocks = createMockFactories({
      connectError: new Error('spawn ENOENT'),
      stderrStream: new PassThrough(),
      stderrLines: [...Array.from({ length: 250 }, (_, i) => `line-${i}`), 'LAST-CRASH-LINE'],
    });
    const entry: McpRegistryEntry = { name: 'noisy', transport: 'stdio', command: 'node', enabled: true };
    const conn = await connectMcpServer(entry, { createTransport: mocks.createTransport, createClient: mocks.createClient });
    expect(conn.status).toBe('failed');
    expect(conn.lastError).toContain('LAST-CRASH-LINE');
    expect(conn.lastError).not.toContain('line-0');
    expect(conn.lastError).not.toContain('line-100');
  });
});
