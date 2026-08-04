import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstructions } from '../src/instructions-loader.js';

describe('loadInstructions', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ecode-instr-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('某层有 CLAUDE.md 时读取其内容', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# 项目规则\n用中文');
    expect(loadInstructions([root])).toContain('用中文');
  });

  it('同层 ECODE.md 优先于 CLAUDE.md', () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'from-claude');
    writeFileSync(join(root, 'ECODE.md'), 'from-ecode');
    const result = loadInstructions([root]);
    expect(result).toContain('from-ecode');
    expect(result).not.toContain('from-claude');
  });

  it('多层目录各自命中时全部拼接（带来源标注）', () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(root, 'ECODE.md'), '顶层规则');
    writeFileSync(join(sub, 'CLAUDE.md'), '子目录规则');
    const result = loadInstructions([root, sub]);
    expect(result).toContain('顶层规则');
    expect(result).toContain('子目录规则');
  });

  it('所有层都无记忆文件时返回空串（不抛错）', () => {
    expect(loadInstructions([root])).toBe('');
  });

  it('目录不存在时优雅返回空串（不抛错）', () => {
    expect(loadInstructions([join(root, 'nope')])).toBe('');
  });
});
