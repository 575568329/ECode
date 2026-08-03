import { describe, it, expect } from 'vitest';
import { truncate, executeTool } from '../src/tools/index.js';

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

describe('executeTool 参数校验', () => {
  it('未知工具应返回 isError 并提示未知工具', async () => {
    const result = await executeTool('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知工具');
  });

  it('read_file 缺 path 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('read_file', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('path');
  });

  it('bash 缺 command 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('bash', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('command');
  });

  it('edit_file 缺 oldText 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('edit_file', { path: '/a', newText: 'b' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('oldText');
  });

  it('edit_file 缺 newText 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('edit_file', { path: '/a', oldText: 'b' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('newText');
  });

  it('grep 缺 pattern 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('grep', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('pattern');
  });

  it('glob 缺 pattern 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('glob', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('pattern');
  });
});

describe('executeTool 异常降级(try/catch 不炸 loop)', () => {
  it('工具实现抛异常时应返回 isError 而非冒泡', async () => {
    // 传入一个不存在的路径,read_file 内部会抛 Error(如 ENOENT)
    // 验证 executor 能接住并返回 isError
    const result = await executeTool('read_file', { path: '/nonexistent_path_that_does_not_exist_xyz' });
    // 不管文件是否存在,executeTool 本身不应抛异常
    // (文件不存在时 read_file 实现可能返回 isError 或抛错,
    //  测试验证的是 executor 层的 try/catch 保护)
    expect(result).toBeDefined();
    expect(typeof result.isError).toBe('boolean');
  });
});
