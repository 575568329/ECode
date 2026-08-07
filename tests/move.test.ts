import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeMove } from '../src/tools/move.js';

describe('executeMove', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('移动文件:源消失、目标存在、内容一致', () => {
    const src = join(dir, 'a.txt');
    const dst = join(dir, 'b.txt');
    writeFileSync(src, 'content', 'utf-8');
    const result = executeMove({ source: src, destination: dst });
    expect(result.isError).toBe(false);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, 'utf-8')).toBe('content');
  });

  it('移动到需新建的嵌套目录(自动建目录)', () => {
    const src = join(dir, 'a.txt');
    const dst = join(dir, 'sub', 'deep', 'b.txt');
    writeFileSync(src, 'x', 'utf-8');
    const result = executeMove({ source: src, destination: dst });
    expect(result.isError).toBe(false);
    expect(existsSync(dst)).toBe(true);
  });

  it('目标已存在 → 覆盖(rename 语义)', () => {
    const src = join(dir, 'a.txt');
    const dst = join(dir, 'b.txt');
    writeFileSync(src, 'new', 'utf-8');
    writeFileSync(dst, 'old', 'utf-8');
    const result = executeMove({ source: src, destination: dst });
    expect(result.isError).toBe(false);
    expect(readFileSync(dst, 'utf-8')).toBe('new');
  });

  it('移动目录', () => {
    const src = join(dir, 'folder');
    mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), 'x');
    const dst = join(dir, 'moved');
    const result = executeMove({ source: src, destination: dst });
    expect(result.isError).toBe(false);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(dst, 'a.txt'))).toBe(true);
  });

  it('源不存在 → fail-fast', () => {
    const result = executeMove({ source: join(dir, 'nope.txt'), destination: join(dir, 'x.txt') });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('源不存在');
  });
});
