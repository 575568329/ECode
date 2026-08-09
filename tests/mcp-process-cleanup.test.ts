// T2/T9：process-cleanup 测试 —— detectPlatform 纯函数 + killProcessTree 双平台。
// vi.mock node:child_process 的 spawn（detectPlatform 抽纯函数，不 mock process.platform）。
// T9：POSIX 从 no-op 升级为 pgrep 树遍历逐个 SIGTERM（借鉴 opencode，消除孙子残留）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import {
  detectPlatform,
  killProcessTree,
  collectDescendants,
  pgrepChildren,
} from '../src/mcp/process-cleanup.js';
import { spawn } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);

/** 造一个带 stdout 的 fake 子进程（pgrep/taskkill 共用 EventEmitter 模型）。 */
function fakeChild(): EventEmitter & { stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  child.stdout = new EventEmitter();
  return child;
}

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

describe('collectDescendants（BFS 树遍历，纯逻辑，注入 getChildren）', () => {
  it('叶子节点（无子）→ []', async () => {
    const getChildren = vi.fn().mockResolvedValue([]);
    expect(await collectDescendants(100, getChildren)).toEqual([]);
    expect(getChildren).toHaveBeenCalledWith(100);
  });

  it('单层（root→[a,b]）→ [a, b]', async () => {
    const tree: Record<number, number[]> = { 100: [200, 300], 200: [], 300: [] };
    const getChildren = vi.fn(async (pid: number) => tree[pid] ?? []);
    expect(await collectDescendants(100, getChildren)).toEqual([200, 300]);
  });

  it('多层 BFS → 按层序展开（100→[200,300], 200→[400]）→ [200, 300, 400]', async () => {
    const tree: Record<number, number[]> = { 100: [200, 300], 200: [400], 300: [], 400: [] };
    const getChildren = vi.fn(async (pid: number) => tree[pid] ?? []);
    expect(await collectDescendants(100, getChildren)).toEqual([200, 300, 400]);
  });

  it('后代含重复 pid（异常成环）→ 去重不死循环', async () => {
    // 400 的子又指回 200（成环）；去重后只收 [200, 400]
    const tree: Record<number, number[]> = { 100: [200], 200: [400], 400: [200] };
    const getChildren = vi.fn(async (pid: number) => tree[pid] ?? []);
    expect(await collectDescendants(100, getChildren)).toEqual([200, 400]);
  });
});

describe('pgrepChildren（spawn pgrep 解析 + 降级）', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('正常解析多行 pid', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = pgrepChildren(100);
    child.stdout.emit('data', Buffer.from('200\n300\n'));
    child.emit('close', 0);
    expect(await p).toEqual([200, 300]);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('pgrep');
    expect(args).toEqual(['-P', '100']);
  });

  it('非数字行忽略', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = pgrepChildren(100);
    child.stdout.emit('data', Buffer.from('200\n\nabc\n300\n'));
    child.emit('close', 0);
    expect(await p).toEqual([200, 300]);
  });

  it('pgrep 不存在（error 事件）→ []（优雅降级，不阻塞）', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = pgrepChildren(100);
    child.emit('error', new Error('spawn pgrep ENOENT'));
    expect(await p).toEqual([]);
  });

  it('空输出 → []', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = pgrepChildren(100);
    child.emit('close', 0);
    expect(await p).toEqual([]);
  });
});

describe('killProcessTree', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('无 pid → no-op（不调 spawn）', async () => {
    await killProcessTree(null, 'win32');
    await killProcessTree(undefined, 'posix');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('win32 → 调 taskkill /T /F /PID（绝对路径）', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = killProcessTree(9999, 'win32');
    child.emit('close', 0);
    await p;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toMatch(/taskkill\.exe$/);
    expect(args).toEqual(['/T', '/F', '/PID', '9999']);
  });

  it('win32 进程已退出（taskkill 非零错误码）→ 仍 resolve（幂等）', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const p = killProcessTree(9999, 'win32');
    child.emit('close', 128);
    await expect(p).resolves.toBeUndefined();
  });

  it('POSIX 无后代（pgrep 空）→ 不 process.kill', async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const p = killProcessTree(100, 'posix');
    child.stdout.emit('data', Buffer.from(''));
    child.emit('close', 0);
    await p;
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('POSIX 有后代 → pgrep 遍历 + 倒序 SIGTERM（先杀深的，避免孤儿）', async () => {
    // 树: 100 → [200], 200 → [300];collectDescendants → [200,300]，倒序 kill → 300 先
    mockSpawn.mockImplementation(((cmd: string, args: string[]) => {
      const child = fakeChild();
      const targetPid = args[args.indexOf('-P') + 1];
      const tree: Record<string, string[]> = { '100': ['200'], '200': ['300'], '300': [] };
      const children = tree[targetPid] ?? [];
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(children.join('\n')));
        child.emit('close', 0);
      });
      return child;
    }) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await killProcessTree(100, 'posix');
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, 300, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 200, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('POSIX process.kill 失败（进程已退出 ESRCH）→ 静默忽略不抛', async () => {
    mockSpawn.mockImplementation(((cmd: string, args: string[]) => {
      const child = fakeChild();
      const targetPid = args[args.indexOf('-P') + 1];
      const tree: Record<string, string[]> = { '100': ['200'], '200': [] };
      const children = tree[targetPid] ?? [];
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(children.join('\n')));
        child.emit('close', 0);
      });
      return child;
    }) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    await expect(killProcessTree(100, 'posix')).resolves.toBeUndefined();
    killSpy.mockRestore();
  });
});
