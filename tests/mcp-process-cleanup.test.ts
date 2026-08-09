// T2：process-cleanup 测试 —— detectPlatform 纯函数 + killProcessTree 双平台。
// vi.mock node:child_process 的 spawn（detectPlatform 抽纯函数，不 mock process.platform）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { detectPlatform, killProcessTree } from '../src/mcp/process-cleanup.js';
import { spawn } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);

describe('detectPlatform', () => {
  it('win32 → win32', () => {
    expect(detectPlatform('win32')).toBe('win32');
  });

  it('linux → posix', () => {
    expect(detectPlatform('linux')).toBe('posix');
  });

  it('darwin → posix', () => {
    expect(detectPlatform('darwin')).toBe('posix');
  });

  it('缺省用 process.platform', () => {
    expect(detectPlatform()).toBe(process.platform === 'win32' ? 'win32' : 'posix');
  });
});

describe('killProcessTree', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('无 pid → no-op（win32 也不调 spawn）', async () => {
    await killProcessTree(null, 'win32');
    await killProcessTree(undefined, 'win32');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('win32 → 调 taskkill /T /F /PID（绝对路径）', async () => {
    const fake = new EventEmitter();
    mockSpawn.mockReturnValue(fake as never);
    const p = killProcessTree(9999, 'win32');
    fake.emit('close', 0);
    await p;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toMatch(/taskkill\.exe$/);
    expect(args).toEqual(['/T', '/F', '/PID', '9999']);
  });

  it('win32 进程已退出（taskkill 非零错误码）→ 仍 resolve（幂等）', async () => {
    const fake = new EventEmitter();
    mockSpawn.mockReturnValue(fake as never);
    const p = killProcessTree(9999, 'win32');
    fake.emit('close', 128); // taskkill 错误码（进程不存在）
    await expect(p).resolves.toBeUndefined();
  });

  it('POSIX → no-op（降级，不调 spawn）', async () => {
    await killProcessTree(9999, 'posix');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('缺省 platform 走 detectPlatform（win32 环境调 taskkill / POSIX 环境跳过）', async () => {
    const fake = new EventEmitter();
    mockSpawn.mockReturnValue(fake as never);
    const p = killProcessTree(9999); // 缺省 platform
    if (process.platform === 'win32') {
      fake.emit('close', 0);
      await p;
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } else {
      await p;
      expect(mockSpawn).not.toHaveBeenCalled();
    }
  });
});
