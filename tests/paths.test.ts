import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from '../src/paths.js';

describe('resolveDataDir', () => {
  // 一期语义：纯提取，= join(homedir(), '.ecode')，行为与历史内联一致（F1 前置）。
  it('返回当前进程 home 下的 .ecode 目录（纯提取，不改语义）', () => {
    expect(resolveDataDir()).toBe(join(homedir(), '.ecode'));
  });

  it('是绝对路径且以 .ecode 结尾', () => {
    const dir = resolveDataDir();
    expect(dir.endsWith('.ecode')).toBe(true);
  });

  it('多次调用返回一致（纯函数，无副作用）', () => {
    expect(resolveDataDir()).toBe(resolveDataDir());
  });
});
