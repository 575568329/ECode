import { describe, it, expect } from 'vitest';
import { isSearchBash, isReadSearchTool, summarizeGroup } from '../../src/ui/read-search-group.js';

// 背景：折叠组延迟冻结（reduce-agent-event 挂起连续只读工具）需要判定哪些工具
// 属于「只读可合并」类。read_file/grep/glob 直接判定；bash 需识别搜索类命令
// (grep/rg/find/ls/fd/ag/cat)。复合命令(管道/&&/;)保守判否——宁可漏合不可误合。
// 详见 docs/详设/20260806220000_折叠组延迟冻结-详设.md §4.1。

describe('isSearchBash（bash 搜索类命令识别）', () => {
  it('裸搜索命令 → true', () => {
    expect(isSearchBash({ command: 'grep foo *.ts' })).toBe(true);
    expect(isSearchBash({ command: 'rg pattern' })).toBe(true);
    expect(isSearchBash({ command: 'find . -name x' })).toBe(true);
    expect(isSearchBash({ command: 'ls -la' })).toBe(true);
    expect(isSearchBash({ command: 'fd .py' })).toBe(true);
    expect(isSearchBash({ command: 'ag TODO' })).toBe(true);
    expect(isSearchBash({ command: 'cat config.json' })).toBe(true);
  });

  it('带路径前缀的搜索命令 → true（取 basename）', () => {
    expect(isSearchBash({ command: '/usr/bin/grep foo' })).toBe(true);
    expect(isSearchBash({ command: './node_modules/.bin/rg pat' })).toBe(true);
  });

  it('非搜索命令 → false', () => {
    expect(isSearchBash({ command: 'npm run dev' })).toBe(false);
    expect(isSearchBash({ command: 'git status' })).toBe(false);
    expect(isSearchBash({ command: 'echo hello' })).toBe(false);
    expect(isSearchBash({ command: 'node script.js' })).toBe(false);
  });

  it('复合命令（管道/&&/;）保守判否 → false', () => {
    // 管道/逻辑与/分号里可能含写操作；保守：宁可漏合不可误合
    expect(isSearchBash({ command: 'grep foo | wc -l' })).toBe(false);
    expect(isSearchBash({ command: 'npm test && npm run build' })).toBe(false);
    expect(isSearchBash({ command: 'cd src; ls' })).toBe(false);
  });

  it('空命令 / 无 command 字段 / 无 input → false', () => {
    expect(isSearchBash({ command: '' })).toBe(false);
    expect(isSearchBash({ command: '   ' })).toBe(false);
    expect(isSearchBash({})).toBe(false);
    expect(isSearchBash(undefined)).toBe(false);
  });
});

describe('isReadSearchTool（只读可合并工具判定）', () => {
  it('read_file / grep / glob → true', () => {
    expect(isReadSearchTool('read_file')).toBe(true);
    expect(isReadSearchTool('grep')).toBe(true);
    expect(isReadSearchTool('glob')).toBe(true);
  });

  it('bash 搜索类 → true（委托 isSearchBash）', () => {
    expect(isReadSearchTool('bash', { command: 'grep foo' })).toBe(true);
    expect(isReadSearchTool('bash', { command: 'rg pattern' })).toBe(true);
  });

  it('bash 非搜索类 → false', () => {
    expect(isReadSearchTool('bash', { command: 'npm test' })).toBe(false);
    expect(isReadSearchTool('bash', { command: 'grep foo | wc -l' })).toBe(false);
  });

  it('写操作类工具 → false', () => {
    expect(isReadSearchTool('edit_file')).toBe(false);
    expect(isReadSearchTool('write_file')).toBe(false);
  });

  it('未知工具 → false', () => {
    expect(isReadSearchTool('mcp__foo')).toBe(false);
  });
});

describe('summarizeGroup（合并摘要）', () => {
  it('单类型计数 + 复数', () => {
    const tools = [{ name: 'read_file' }, { name: 'read_file' }, { name: 'read_file' }];
    expect(summarizeGroup(tools)).toBe('Read 3 files');
  });

  it('单数（1 个）各类型', () => {
    expect(summarizeGroup([{ name: 'read_file' }])).toBe('Read 1 file');
    expect(summarizeGroup([{ name: 'grep' }])).toBe('Searched 1 pattern');
    expect(summarizeGroup([{ name: 'glob' }])).toBe('1 glob');
    expect(summarizeGroup([{ name: 'bash' }])).toBe('1 search');
  });

  it('混合多类型 → 用 · 分隔', () => {
    const tools = [
      { name: 'read_file' }, { name: 'read_file' }, { name: 'read_file' },
      { name: 'grep' }, { name: 'grep' },
      { name: 'glob' },
    ];
    expect(summarizeGroup(tools)).toBe('Read 3 files · Searched 2 patterns · 1 glob');
  });

  it('bash 复数 → searches（加 es）', () => {
    expect(summarizeGroup([{ name: 'bash' }, { name: 'bash' }])).toBe('2 searches');
  });

  it('空数组 → 空串', () => {
    expect(summarizeGroup([])).toBe('');
  });
});
