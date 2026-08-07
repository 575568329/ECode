import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeLs } from '../src/tools/ls.js';

describe('executeLs', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-ls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, 'b.md'), 'x');
    writeFileSync(join(dir, 'c.ts'), 'x');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('列目录返回全部条目', () => {
    const r = executeLs({ path: dir });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts');
    expect(r.content).toContain('b.md');
    expect(r.content).toContain('c.ts');
  });

  it('pattern 子串过滤', () => {
    const r = executeLs({ path: dir, pattern: '.ts' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts');
    expect(r.content).toContain('c.ts');
    expect(r.content).not.toContain('b.md');
  });

  it('无匹配 → 空提示', () => {
    const r = executeLs({ path: dir, pattern: '.zzz' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('空目录或无匹配');
  });

  it('空目录 → 空提示', () => {
    const sub = join(dir, 'empty');
    mkdirSync(sub);
    const r = executeLs({ path: sub });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('空目录或无匹配');
  });

  it('目录不存在 → 失败', () => {
    const r = executeLs({ path: join(dir, 'nope') });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('列目录失败');
  });
});
