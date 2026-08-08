import { describe, it, expect } from 'vitest';
import { prefix, reduceCommand, toAlwaysPattern, splitCompound } from '../../src/permission/arity.js';

describe('prefix（最长前缀匹配归约）', () => {
  it('git checkout main → git checkout（git arity=2）', () => {
    expect(prefix(['git', 'checkout', 'main'])).toEqual(['git', 'checkout']);
  });

  it('npm run test → npm run test（npm run arity=3，整段保留）', () => {
    expect(prefix(['npm', 'run', 'test'])).toEqual(['npm', 'run', 'test']);
  });

  it('git config user.name → git config user.name（git config arity=3）', () => {
    expect(prefix(['git', 'config', 'user.name'])).toEqual(['git', 'config', 'user.name']);
  });

  it('ls -la → ls（ls arity=1，截断 flags）', () => {
    expect(prefix(['ls', '-la'])).toEqual(['ls']);
  });

  it('echo one → echo（echo arity=1）', () => {
    expect(prefix(['echo', 'one'])).toEqual(['echo']);
  });

  it('unknown cmd → unknown（未命中字典取首 token）', () => {
    expect(prefix(['unknown', 'cmd'])).toEqual(['unknown']);
  });

  it('空数组 → []', () => {
    expect(prefix([])).toEqual([]);
  });
});

describe('reduceCommand（tokenize + 剥引号 + prefix + join）', () => {
  it('git checkout main → git checkout', () => {
    expect(reduceCommand('git checkout main')).toBe('git checkout');
  });

  it('npm install → npm install（npm arity=2）', () => {
    expect(reduceCommand('npm install')).toBe('npm install');
  });

  it('echo hello → echo（echo arity=1）', () => {
    expect(reduceCommand('echo hello')).toBe('echo');
  });

  it('剥离前导/包裹引号', () => {
    expect(reduceCommand('"git" checkout main')).toBe('git checkout');
    expect(reduceCommand("'git' checkout main")).toBe('git checkout');
  });

  it('多余空白折叠', () => {
    expect(reduceCommand('  git   checkout   main  ')).toBe('git checkout');
  });
});

describe('toAlwaysPattern（reduceCommand + " *"）', () => {
  it('git checkout main → git checkout *', () => {
    expect(toAlwaysPattern('git checkout main')).toBe('git checkout *');
  });

  it('ls → ls *', () => {
    expect(toAlwaysPattern('ls')).toBe('ls *');
  });

  it('echo one → echo *', () => {
    expect(toAlwaysPattern('echo one')).toBe('echo *');
  });

  it('npm test → npm test *', () => {
    expect(toAlwaysPattern('npm test')).toBe('npm test *');
  });
});

describe('splitCompound（复合命令按操作符拆段）', () => {
  it('a && b → [a, b]', () => {
    expect(splitCompound('a && b')).toEqual(['a', 'b']);
  });

  it('a || b → [a, b]', () => {
    expect(splitCompound('a || b')).toEqual(['a', 'b']);
  });

  it('a | b → [a, b]（管道）', () => {
    expect(splitCompound('a | b')).toEqual(['a', 'b']);
  });

  it('a ; b → [a, b]', () => {
    expect(splitCompound('a ; b')).toEqual(['a', 'b']);
  });

  it('混合 a && b | c ; d → [a, b, c, d]', () => {
    expect(splitCompound('a && b | c ; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('无操作符 → [原串]', () => {
    expect(splitCompound('git status')).toEqual(['git status']);
  });

  it('a||b（无空格）→ [a, b]（仍拆——防尾部 * 贪婪放行）', () => {
    // 安全考量：'a||b' 不拆则整段 'a||b' 可能被 'a *' 贪婪匹配放行（compound bypass）。
    expect(splitCompound('a||b')).toEqual(['a', 'b']);
  });

  it('npm install; rm -rf /tmp（分号前无空格）→ [npm install, rm -rf /tmp]', () => {
    // 经典 compound bypass 场景：必须拆出 rm 段，否则 'npm install *' 整段放行。
    expect(splitCompound('npm install; rm -rf /tmp')).toEqual(['npm install', 'rm -rf /tmp']);
  });

  it('空串 → []', () => {
    expect(splitCompound('')).toEqual([]);
  });
});
