import { describe, it, expect } from 'vitest';
import { truncate, executeTool, toolDefinitions } from '../src/tools/index.js';

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

  it('bash 失败 → content 取纯 stderr（去 Node "Command failed: cmd" 重复，UI/agent 都见干净错误）', async () => {
    const result = await executeTool('bash', {
      command: 'node -e "console.error(\'boom\'); process.exit(1)"',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
    expect(result.content).not.toContain('Command failed');
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

describe('v2 声明式工具（execute 挂在定义上）', () => {
  it('toolDefinitions 每个工具都有 execute 函数', () => {
    for (const tool of toolDefinitions) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('executor 不含 switch/case（纯 find + execute 分发）', async () => {
    // 通过确认"有 execute 的工具能执行"来间接验证 executor 走的是 execute 字段
    // 而非硬编码 switch
    const result = await executeTool('bash', { command: 'echo hello' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });

  it('registry 上无 execute 的工具 → executor 返回"未实现"', async () => {
    const original = toolDefinitions.find((t) => t.name === 'glob');
    if (original) {
      const saved = original.execute;
      // @ts-expect-error 测试用：临时移除 execute
      delete original.execute;
      const result = await executeTool('glob', { pattern: '*.ts' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('未实现');
      original.execute = saved; // 恢复
    }
  });
});

describe('ToolDefinition.dangerous 标记（M3.5 权限闸门消费）', () => {
  it('bash 工具标记为 dangerous（需权限审批）', () => {
    const bash = toolDefinitions.find((t) => t.name === 'bash');
    expect(bash?.dangerous).toBe(true);
  });

  it('edit_file 标记为 dangerous（M4 缺口修复：编辑文件需审批，不再静默修改）', () => {
    const edit = toolDefinitions.find((t) => t.name === 'edit_file');
    expect(edit?.dangerous).toBe(true);
  });

  it('只读工具（read_file/grep/glob）未标 dangerous', () => {
    const readonly = toolDefinitions.filter((t) =>
      ['read_file', 'grep', 'glob'].includes(t.name),
    );
    for (const t of readonly) {
      expect(t.dangerous ?? false).toBe(false);
    }
  });
});

describe('🔴-A 新增工具集（write_file/delete_file/move/ls）', () => {
  it('副作用工具（write_file/delete_file/move）标记为 dangerous', () => {
    const sideEffect = toolDefinitions.filter((t) =>
      ['write_file', 'delete_file', 'move'].includes(t.name),
    );
    expect(sideEffect.length).toBe(3); // 三个都在
    for (const t of sideEffect) {
      expect(t.dangerous).toBe(true);
    }
  });

  it('ls 工具未标 dangerous（只读放行）', () => {
    const ls = toolDefinitions.find((t) => t.name === 'ls');
    expect(ls?.dangerous ?? false).toBe(false);
  });

  it('每个新工具都有 execute 函数', () => {
    const news = toolDefinitions.filter((t) =>
      ['write_file', 'delete_file', 'move', 'ls'].includes(t.name),
    );
    expect(news.length).toBe(4);
    for (const t of news) {
      expect(typeof t.execute).toBe('function');
    }
  });
});

describe('🔴-A 新工具参数缺失校验（executor 统一 required）', () => {
  it('write_file 缺 content 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('write_file', { path: '/a' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('content');
  });

  it('delete_file 缺 path 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('delete_file', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('path');
  });

  it('move 缺 destination 应返回 isError(参数缺失)', async () => {
    const result = await executeTool('move', { source: '/a' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数缺失');
    expect(result.content).toContain('destination');
  });
});
