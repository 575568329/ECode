import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeWriteFile } from '../src/tools/write-file.js';

describe('executeWriteFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ecode-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('写入新文件成功并返回字符数', () => {
    const file = join(dir, 'a.txt');
    const result = executeWriteFile({ path: file, content: 'hello world' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('11 字符');
    expect(readFileSync(file, 'utf-8')).toBe('hello world');
  });

  it('已存在文件直接覆盖(整文件覆盖语义)', () => {
    const file = join(dir, 'b.txt');
    writeFileSync(file, 'old content', 'utf-8');
    const result = executeWriteFile({ path: file, content: 'new' });
    expect(result.isError).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('new');
  });

  it('自动创建嵌套目录(写到不存在的子目录)', () => {
    const file = join(dir, 'sub', 'deep', 'c.txt');
    const result = executeWriteFile({ path: file, content: 'x' });
    expect(result.isError).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('空内容写入成功(0 字符)', () => {
    const file = join(dir, 'empty.txt');
    const result = executeWriteFile({ path: file, content: '' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('0 字符');
    expect(statSync(file).size).toBe(0);
  });

  it('路径是已存在目录时写入失败', () => {
    const result = executeWriteFile({ path: dir, content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('写入文件失败');
  });
});
