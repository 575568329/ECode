import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock manager 单例：测试只关心 shutdown 是否调 disconnectAll / 是否 exit，
// 不真正连 MCP（避免 spawn 子进程、污染 CI）。
vi.mock('../src/mcp/manager.js', () => ({
  getMcpManagerOrNull: vi.fn(),
}));

import { shutdown } from '../src/lifecycle.js';
import { getMcpManagerOrNull } from '../src/mcp/manager.js';

// process.exit mock：阻止真退出，改抛错便于断言「走到了 exit」。
// （process.exit :never，spy 需强转；mockImplementation 抛错让 await 的 promise reject）
type ExitSpy = ReturnType<typeof vi.spyOn>;

describe('shutdown（统一退出：清理 MCP 子进程后 exit，debugging #019）', () => {
  let exitSpy: ExitSpy;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getMcpManagerOrNull).mockReset();
    vi.useRealTimers();
  });

  it('正常分支：disconnectAll 完成后 process.exit(0)', async () => {
    const disconnectAll = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getMcpManagerOrNull).mockReturnValue({ disconnectAll, hasActiveConnections: () => true } as never);

    await expect(shutdown(0)).rejects.toThrow('process.exit(0)');
    expect(disconnectAll).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('CLI 模式（manager 未初始化 → null）：不调 disconnectAll，直接 process.exit', async () => {
    vi.mocked(getMcpManagerOrNull).mockReturnValue(null);

    await expect(shutdown(0)).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('超时兜底：disconnectAll 卡死 → 3s 后仍 process.exit（不卡死终端）', async () => {
    vi.useFakeTimers();
    // disconnectAll 永不 resolve（模拟 MCP server 不响应 close，SDK close 挂起）
    const disconnectAll = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    vi.mocked(getMcpManagerOrNull).mockReturnValue({ disconnectAll, hasActiveConnections: () => true } as never);

    const p = shutdown(1);
    vi.advanceTimersByTime(3000); // 推进到超时定时器触发
    await expect(p).rejects.toThrow('process.exit(1)');
    expect(disconnectAll).toHaveBeenCalledOnce();
  });

  it('disconnectAll 抛错不阻塞退出（catch 兜底，尽力而为）', async () => {
    const disconnectAll = vi.fn().mockRejectedValue(new Error('close failed'));
    vi.mocked(getMcpManagerOrNull).mockReturnValue({ disconnectAll, hasActiveConnections: () => true } as never);

    await expect(shutdown(0)).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('fast-path：manager 存在但无活跃连接 → 跳过 disconnectAll，直接同步 process.exit', async () => {
    // REPL 测试环境 / CLI 模式：单例已初始化但 pool 无连接 → shutdown 不走 async 清理，
    // process.exit 同步触发（保持退出回调同步语义，repl-human 双击 Ctrl+C / /exit 断言不破坏）。
    const disconnectAll = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getMcpManagerOrNull).mockReturnValue({ disconnectAll, hasActiveConnections: () => false } as never);

    await expect(shutdown(0)).rejects.toThrow('process.exit(0)');
    expect(disconnectAll).not.toHaveBeenCalled(); // fast-path 跳过 async 清理
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
