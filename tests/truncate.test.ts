import { describe, it, expect } from 'vitest';
import { truncateByLines } from '../src/tools/truncate.js';

describe('truncateByLines', () => {
  it('短文件（行数 ≤ maxLines）应原样返回', () => {
    const content = 'line1\nline2\nline3';
    expect(truncateByLines(content, 5)).toBe(content);
  });

  it('空字符串应原样返回', () => {
    expect(truncateByLines('', 100)).toBe('');
  });

  it('超过 maxLines 应截断并标注行数信息', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    const result = truncateByLines(content, 5);

    // 应保留前 5 行
    expect(result).toContain('line 1');
    expect(result).toContain('line 5');
    expect(result).not.toContain('line 6');

    // 应包含截断标注
    expect(result).toContain('共 10 行');
    expect(result).toContain('仅显示前 5 行');
  });

  it('超过 maxLineChars 的单行应截断并标注', () => {
    // 生成一行超长内容
    const longLine = 'a'.repeat(3000);
    const content = `${longLine}\nline2\nline3`;
    const result = truncateByLines(content, 5, 2000);

    // 第一行应被截断
    expect(result).toContain('仅显示前 2000 字符');
    expect(result).not.toContain('a'.repeat(2500));
  });

  it('行数和单行字符都超限时应同时标注', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}: ${'x'.repeat(i === 0 ? 3000 : 10)}`);
    const content = lines.join('\n');
    const result = truncateByLines(content, 3, 2000);

    // 应有行数截断标注
    expect(result).toContain('共 10 行');
    expect(result).toContain('仅显示前 3 行');
    // 第一行也应有字符截断标注
    expect(result).toContain('仅显示前 2000 字符');
  });

  it('默认 maxLines=2000, maxLineChars=2000', () => {
    // 生成 3000 行
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    const result = truncateByLines(content);

    expect(result).toContain('共 3000 行');
    expect(result).toContain('仅显示前 2000 行');
  });
});
