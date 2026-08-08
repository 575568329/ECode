import { describe, it, expect } from 'vitest';
import { match } from '../../src/permission/wildcard.js';

describe('match（通配符匹配，抄 opencode wildcard.ts）', () => {
  it('npm run * ↔ npm run test = true', () => {
    expect(match('npm run test', 'npm run *')).toBe(true);
  });

  it('git checkout * ↔ git checkout main = true', () => {
    expect(match('git checkout main', 'git checkout *')).toBe(true);
  });

  it('git checkout * ↔ git status = false（前缀不同）', () => {
    expect(match('git status', 'git checkout *')).toBe(false);
  });

  it('ls * ↔ ls = true（尾部可选：无参数也匹配）', () => {
    expect(match('ls', 'ls *')).toBe(true);
  });

  it('ls * ↔ ls -la = true（尾部匹配参数）', () => {
    expect(match('ls -la', 'ls *')).toBe(true);
  });

  it('echo * ↔ echo one = true', () => {
    expect(match('echo one', 'echo *')).toBe(true);
  });

  it('npm install * ↔ npm install = true', () => {
    expect(match('npm install', 'npm install *')).toBe(true);
  });

  it('rm -rf * ↔ echo hi = false（不同命令）', () => {
    expect(match('echo hi', 'rm -rf *')).toBe(false);
  });

  it('大小写不敏感（Windows 兼容）：LS ↔ ls * = true', () => {
    expect(match('LS', 'ls *')).toBe(true);
  });

  it('ls*（无空格）↔ lstmeval = true（警示：调用方须始终用 " *"）', () => {
    // 无空格的 'ls*' 退化为前缀匹配，会误放行——故 toAlwaysPattern 固定追加 ' *'。
    expect(match('lstmeval', 'ls*')).toBe(true);
  });

  it('compound bypass 根因证据（操作符两侧有空格）：npm install && rm -rf / 被 npm install * 命中 = true', () => {
    // && 两侧有空格时，'npm install *' 的尾部 ( .*)? 贪婪吞掉 ' && rm -rf /' → 越权放行。
    // 故 splitCompound 必须拆段，让 rm 段独立受审。这是「拆段」非可选的硬证据。
    expect(match('npm install && rm -rf /', 'npm install *')).toBe(true);
  });

  it('尾部 ( .*)? 需前导空格：npm install; rm（; 前无空格）不被 npm install * 命中 = false', () => {
    // 实证发现：尾部可选组要求一个前导空格；'install;' 的 ';' 紧贴 install，无空格 → 不匹配。
    // 故「操作符前无空格」写法天然不被前缀 pattern 放行；但 splitCompound 仍要拆（防有空格写法 + &&/|| 场景）。
    expect(match('npm install; rm -rf /', 'npm install *')).toBe(false);
  });
});
