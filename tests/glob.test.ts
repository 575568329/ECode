import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeGlob } from '../src/tools/glob.js';

describe('executeGlob', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, 'b.md'), 'x');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.ts'), 'x');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('按 **/*.ts 匹配含子目录', async () => {
    const r = await executeGlob({ pattern: '**/*.ts', path: dir });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts');
    expect(r.content).toContain('c.ts');
    expect(r.content).not.toContain('b.md');
  });

  it('无匹配返回「未找到」', async () => {
    const r = await executeGlob({ pattern: '**/*.xyz', path: dir });
    expect(r.content).toContain('未找到');
  });
});
