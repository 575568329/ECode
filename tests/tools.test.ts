import { describe, it, expect } from 'vitest';
import { truncate, executeTool } from '../src/tools.js';

describe('truncate', () => {
  it('短文本（< max）应原样返回', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('正好等于 max 应原样返回', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });

  it('空字符串应原样返回', () => {
    expect(truncate('', 100)).toBe('');
  });

  it('超过 max 应截断并标注「共 N 字符 / 仅显示前 M」', () => {
    const result = truncate('abcdefghij', 5);
    expect(result).toContain('abcde');           // 保留前 max 字符
    expect(result).toContain('共 10 字符');        // 标注原始总长度
    expect(result).toContain('仅显示前 5 字符');    // 标注显示长度
  });

  it('不传 max 时用默认上限 MAX_OUTPUT_LENGTH(30000)', () => {
    const long = 'a'.repeat(40000);
    const result = truncate(long);
    expect(result).toContain('共 40000 字符');
    expect(result).toContain('仅显示前 30000');
  });
});

describe('executeTool 分发', () => {
  it('未知工具应返回 isError 并提示未知工具', async () => {
    const result = await executeTool('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知工具');
  });
});
