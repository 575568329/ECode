import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeGrep } from '../src/tools/grep.js';

describe('executeGrep', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'export const X = 1;\nconst Y = 2;\n');
    writeFileSync(join(dir, 'b.md'), '# Title\nhello world\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.ts'), 'export const Z = 3;\n');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('正则匹配多文件多行（含子目录）', async () => {
    const r = await executeGrep({ pattern: 'export const', path: dir });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts:1:');
    expect(r.content).toContain('c.ts'); // 子目录文件，跨平台用文件名断言
  });

  it('include 过滤文件类型', async () => {
    const r = await executeGrep({ pattern: 'hello|X', path: dir, include: '*.md' });
    expect(r.content).toContain('b.md');
    expect(r.content).not.toContain('a.ts');
  });

  it('无匹配返回「未找到」', async () => {
    const r = await executeGrep({ pattern: 'zzz_not_exist', path: dir });
    expect(r.content).toContain('未找到');
  });

  it('无效正则报错', async () => {
    const r = await executeGrep({ pattern: '(', path: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('正则表达式无效');
  });
});
