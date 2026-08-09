import { describe, it, expect, afterEach } from 'vitest';
import {
  parseUserInput,
  SLASH_COMMANDS,
  registerCommand,
  unregisterCommand,
  getAllCommands,
  registerCommandHandler,
  findCommandHandler,
} from '../src/slash-commands.js';

describe('parseUserInput', () => {
  it('以 / 开头且命中注册表 → 返回 SlashCommand', () => {
    expect(parseUserInput('/help')).toEqual({ type: 'command', name: 'help', args: [] });
  });

  it('带参数的命令 → args 拆分', () => {
    expect(parseUserInput('/model deepseek')).toEqual({
      type: 'command',
      name: 'model',
      args: ['deepseek'],
    });
  });

  it('非 / 开头 → 返回 message', () => {
    expect(parseUserInput('帮我读文件')).toEqual({ type: 'message', text: '帮我读文件' });
  });

  it('/ 开头但未注册 → 返回 unknown command（不静默当 message）', () => {
    expect(parseUserInput('/foobar')).toEqual({ type: 'unknown_command', raw: '/foobar' });
  });

  it('空串 → message（空文本）', () => {
    expect(parseUserInput('')).toEqual({ type: 'message', text: '' });
  });
});

describe('SLASH_COMMANDS 注册表', () => {
  it('包含 MVP 四命令 help/clear/model/exit', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('help');
    expect(names).toContain('clear');
    expect(names).toContain('model');
    expect(names).toContain('exit');
  });

  it('阶段②新增 4 命令 cost/compact/resume/sessions', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('cost');
    expect(names).toContain('compact');
    expect(names).toContain('resume');
    expect(names).toContain('sessions');
    expect(names).toContain('mcp');
    expect(names).toContain('skill');
    expect(names).toHaveLength(10);
  });
});

describe('动态命令注册（阶段 3 MCP 前置）', () => {
  // 每个测试后清理动态注册，避免测试间污染
  afterEach(() => {
    unregisterCommand('mcp__test__search');
    unregisterCommand('mcp__test__query');
    unregisterCommand('dyn__custom');
  });

  it('registerCommand → parseUserInput 识别动态命令', () => {
    registerCommand({
      name: 'mcp__test__search',
      description: '搜索',
      source: 'mcp',
      execute: async () => {},
    });
    expect(parseUserInput('/mcp__test__search foo')).toEqual({
      type: 'command',
      name: 'mcp__test__search',
      args: ['foo'],
    });
  });

  it('unregisterCommand → parseUserInput 不再识别', () => {
    registerCommand({
      name: 'mcp__test__search',
      description: '搜索',
      source: 'mcp',
      execute: async () => {},
    });
    unregisterCommand('mcp__test__search');
    expect(parseUserInput('/mcp__test__search')).toEqual({
      type: 'unknown_command',
      raw: '/mcp__test__search',
    });
  });

  it('getAllCommands 包含内置 + 动态', () => {
    registerCommand({ name: 'dyn__custom', description: '自定义', source: 'mcp', execute: async () => {} });
    const all = getAllCommands();
    expect(all.map((c) => c.name)).toContain('help'); // 内置
    expect(all.map((c) => c.name)).toContain('dyn__custom'); // 动态
    expect(all.length).toBe(SLASH_COMMANDS.length + 1);
  });

  it('registerCommand 自带 execute → findCommandHandler 可找到', async () => {
    let called = false;
    registerCommand({
      name: 'mcp__test__query',
      description: '查询',
      source: 'mcp',
      execute: async () => {
        called = true;
      },
    });
    const handler = findCommandHandler('mcp__test__query');
    expect(handler).toBeDefined();
    await handler!([], { addMessage: () => {} });
    expect(called).toBe(true);
  });

  it('registerCommandHandler 注册内置命令 handler', async () => {
    registerCommandHandler('dyn__custom', async () => {});
    expect(findCommandHandler('dyn__custom')).toBeDefined();
  });
});
