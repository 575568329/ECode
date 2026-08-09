import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeEditFile } from '../src/tools/edit-file.js';

describe('executeEditFile', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `ecode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  });

  afterEach(() => {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  });

  it('oldText 唯一匹配时替换成功', async () => {
    writeFileSync(tmpFile, 'hello world', 'utf-8');
    const result = await executeEditFile({ path: tmpFile, oldText: 'world', newText: 'ECode' });
    expect(result.isError).toBe(false);
    expect(readFileSync(tmpFile, 'utf-8')).toBe('hello ECode');
  });

  it('替换成功 → content 含 unified diff（- 旧行 / + 新行 / @@ hunk，供 UI 着色与 LLM 理解）', async () => {
    writeFileSync(tmpFile, 'line1\nline2\nline3', 'utf-8');
    const result = await executeEditFile({ path: tmpFile, oldText: 'line2', newText: 'changed' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('-line2');
    expect(result.content).toContain('+changed');
    expect(result.content).toMatch(/@@.*@@/);
  });

  it('未找到 oldText 时返回 isError 并回喂带行号的文件真实内容', async () => {
    writeFileSync(tmpFile, 'line1\nline2', 'utf-8');
    const result = await executeEditFile({ path: tmpFile, oldText: '不存在', newText: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到');
    expect(result.content).toContain('1: line1');
    expect(result.content).toContain('2: line2');
  });

  it('oldText 多次匹配时报错并提示补充上下文', async () => {
    writeFileSync(tmpFile, 'dup\ndup', 'utf-8');
    const result = await executeEditFile({ path: tmpFile, oldText: 'dup', newText: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('2 次');
    expect(result.content).toContain('更多上下文');
  });

  it('文件不存在时报错', async () => {
    const result = await executeEditFile({
      path: join(tmpdir(), `not-exist-${Date.now()}.txt`),
      oldText: 'a',
      newText: 'b',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('读取文件失败');
  });

  it('空 oldText 不替换（视为未找到）', async () => {
    writeFileSync(tmpFile, 'abc', 'utf-8');
    const result = await executeEditFile({ path: tmpFile, oldText: '', newText: 'x' });
    expect(result.isError).toBe(true);
    expect(readFileSync(tmpFile, 'utf-8')).toBe('abc'); // 原文件未被改
  });
});
