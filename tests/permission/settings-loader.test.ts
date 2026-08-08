import { describe, it, expect } from 'vitest';
import {
  parseRuleString,
  buildRulesFromSettings,
  type PermissionSettingsFile,
} from '../../src/permission/settings-loader.js';

describe('parseRuleString（规则字符串 → tool/pattern）', () => {
  it('Bash(rm -rf *) → tool=bash, pattern=rm -rf *', () => {
    expect(parseRuleString('Bash(rm -rf *)')).toEqual({ tool: 'bash', pattern: 'rm -rf *' });
  });

  it('Bash(npm run test) → tool=bash, pattern=npm run test', () => {
    expect(parseRuleString('Bash(npm run test)')).toEqual({ tool: 'bash', pattern: 'npm run test' });
  });

  it('Edit(.env) → 别名归一为 edit_file', () => {
    expect(parseRuleString('Edit(.env)')).toEqual({ tool: 'edit_file', pattern: '.env' });
  });

  it('Write(*) → 别名归一为 write_file, pattern=*', () => {
    expect(parseRuleString('Write(*)')).toEqual({ tool: 'write_file', pattern: '*' });
  });

  it('Read(./src/**) → 别名归一为 read_file', () => {
    expect(parseRuleString('Read(./src/**)')).toEqual({ tool: 'read_file', pattern: './src/**' });
  });

  it('大小写别名：BASH(...) 也接受（小写化）', () => {
    expect(parseRuleString('Bash(git push)')).toEqual({ tool: 'bash', pattern: 'git push' });
  });

  it('未知工具名小写化：Custom(foo *) → tool=custom', () => {
    expect(parseRuleString('Custom(foo *)')).toEqual({ tool: 'custom', pattern: 'foo *' });
  });

  it('缺右括号 → null', () => {
    expect(parseRuleString('Bash(rm -rf')).toBeNull();
  });

  it('空 pattern：Bash() → null（无可匹配内容）', () => {
    expect(parseRuleString('Bash()')).toBeNull();
  });

  it('非法工具名（数字开头）：1abc(x) → null', () => {
    expect(parseRuleString('1abc(x)')).toBeNull();
  });

  it('纯文本无括号 → null', () => {
    expect(parseRuleString('just text')).toBeNull();
  });

  it('pattern 含括号：Bash(echo "(hi)") → 保留内部括号', () => {
    // pattern 内的括号应被贪婪保留到最后一个 ')'。
    expect(parseRuleString('Bash(echo "(hi)")')).toEqual({ tool: 'bash', pattern: 'echo "(hi)"' });
  });
});

describe('buildRulesFromSettings（settings 对象 → Rule[]）', () => {
  it('deny 数组 → action=deny 的 Rule[]', () => {
    const file: PermissionSettingsFile = { deny: ['Bash(rm -rf *)', 'Edit(.env)'] };
    const rules = buildRulesFromSettings(file, 'user');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ tool: 'bash', pattern: 'rm -rf *', action: 'deny', source: 'user' });
    expect(rules[1]).toEqual({ tool: 'edit_file', pattern: '.env', action: 'deny', source: 'user' });
  });

  it('allow + ask 各转对应 action', () => {
    const file: PermissionSettingsFile = {
      allow: ['Bash(npm run *)'],
      ask: ['Bash(git push *)'],
    };
    const rules = buildRulesFromSettings(file, 'project');
    expect(rules).toEqual([
      { tool: 'bash', pattern: 'npm run *', action: 'allow', source: 'project' },
      { tool: 'bash', pattern: 'git push *', action: 'ask', source: 'project' },
    ]);
  });

  it('非法规则字符串静默跳过（不抛、不含 null）', () => {
    const file: PermissionSettingsFile = { deny: ['Bash(valid)', 'bad-no-parens', '', 'Bash()'] };
    const rules = buildRulesFromSettings(file, 'user');
    expect(rules).toEqual([{ tool: 'bash', pattern: 'valid', action: 'deny', source: 'user' }]);
  });

  it('空 / 缺失数组 → []', () => {
    expect(buildRulesFromSettings({}, 'user')).toEqual([]);
    expect(buildRulesFromSettings({ allow: [] }, 'user')).toEqual([]);
  });
});
