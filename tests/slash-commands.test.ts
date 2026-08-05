import { describe, it, expect } from 'vitest';
import { parseUserInput, SLASH_COMMANDS } from '../src/slash-commands.js';

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
    expect(names).toHaveLength(8);
  });
});
