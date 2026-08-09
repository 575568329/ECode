import { describe, it, expect } from 'vitest';
import { isSearchBash, isReadSearchTool, isMergeableTool, summarizeGroup } from '../../src/ui/read-search-group.js';

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

// C3：扩大合并范围到所有 bash（含 npm/git/test/复合命令），连续 bash 探索合并减少占位。
// 区别于 isReadSearchTool（只读语义判定）：isMergeableTool 是「UI 合并显示」门控，与只读无关。
describe('isMergeableTool（C3：同类工具合并门控，含所有 bash）', () => {
  it('read_file / grep / glob → true（只读组原成员）', () => {
    expect(isMergeableTool('read_file')).toBe(true);
    expect(isMergeableTool('grep')).toBe(true);
    expect(isMergeableTool('glob')).toBe(true);
  });

  it('所有 bash → true（含非搜索 / 复合命令，C3 核心扩大项）', () => {
    // 搜索类（原 read-search 成员）
    expect(isMergeableTool('bash', { command: 'grep foo' })).toBe(true);
    expect(isMergeableTool('bash', { command: 'cat x' })).toBe(true);
    // 非搜索类（C3 扩大：npm/git/test 也合并，用户痛点即此——连续 bash 各占一块）
    expect(isMergeableTool('bash', { command: 'npm install' })).toBe(true);
    expect(isMergeableTool('bash', { command: 'git status' })).toBe(true);
    // 复合命令（isSearchBash 判否，但 isMergeableTool 仍合并：cd && cat 是只读探索）
    expect(isMergeableTool('bash', { command: 'cd /tmp && cat pkg.json' })).toBe(true);
    expect(isMergeableTool('bash', { command: 'npm test && npm run build' })).toBe(true);
  });

  it('写操作类工具 → false（edit_file/write_file 仍单独成块，diff/写入是精华）', () => {
    expect(isMergeableTool('edit_file')).toBe(false);
    expect(isMergeableTool('write_file')).toBe(false);
  });

  it('未知工具 → false', () => {
    expect(isMergeableTool('mcp__foo')).toBe(false);
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
    expect(summarizeGroup([{ name: 'bash' }])).toBe('Ran 1 command');
  });

  it('混合多类型 → 用 · 分隔', () => {
    const tools = [
      { name: 'read_file' }, { name: 'read_file' }, { name: 'read_file' },
      { name: 'grep' }, { name: 'grep' },
      { name: 'glob' },
    ];
    expect(summarizeGroup(tools)).toBe('Read 3 files · Searched 2 patterns · 1 glob');
  });

  it('bash 复数 → Ran N commands（C3：通用命令计数，不再叫 search）', () => {
    expect(summarizeGroup([{ name: 'bash' }, { name: 'bash' }])).toBe('Ran 2 commands');
  });

  it('空数组 → 空串', () => {
    expect(summarizeGroup([])).toBe('');
  });
});
