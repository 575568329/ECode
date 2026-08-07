import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeDeleteFile } from '../src/tools/delete-file.js';

describe('executeDeleteFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-del-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('删除文件成功', () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x', 'utf-8');
    const result = executeDeleteFile({ path: file });
    expect(result.isError).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('recursive=false 删非空目录 → fail-fast 明确提示(非 ENOTEMPTY)', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'a.txt'), 'x');
    const result = executeDeleteFile({ path: sub });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('recursive=true');
    expect(existsSync(sub)).toBe(true); // 未删
  });

  it('recursive=true 删非空目录成功', () => {
    const sub = join(dir, 'tree');
    mkdirSync(sub);
    writeFileSync(join(sub, 'a.txt'), 'x');
    writeFileSync(join(sub, 'b.txt'), 'y');
    const result = executeDeleteFile({ path: sub, recursive: true });
    expect(result.isError).toBe(false);
    expect(existsSync(sub)).toBe(false);
  });

  it('recursive=false 删空目录成功', () => {
    const sub = join(dir, 'empty');
    mkdirSync(sub);
    const result = executeDeleteFile({ path: sub });
    expect(result.isError).toBe(false);
    expect(existsSync(sub)).toBe(false);
  });

  it('删除不存在路径 → 失败(force:false 不静默成功)', () => {
    const result = executeDeleteFile({ path: join(dir, 'nope.txt') });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('删除失败');
  });
});
