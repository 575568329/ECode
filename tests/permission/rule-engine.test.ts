import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { AllowList } from '../../src/permission.js';
import { check, type CheckOptions } from '../../src/permission/rule-engine.js';

describe('check', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `ecode-re-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  // helper：默认一次 check 调用，测试用 override 聚焦单一变量（默认 bash+dangerous+default）
  function run(over: Partial<CheckOptions>) {
    return check({
      toolName: 'bash',
      input: {},
      isDangerous: true,
      mode: 'default',
      allow: new AllowList(),
      roots: [root],
      ...over,
    });
  }

  describe('bypass 模式', () => {
    it('危险工具 → allow', () => {
      expect(run({ mode: 'bypass', toolName: 'bash', isDangerous: true }).action).toBe('allow');
    });

    it('敏感文件 → allow（免疫 path-guard，短路在最前）', () => {
      const v = run({ mode: 'bypass', toolName: 'edit_file', input: { path: join(root, '.env') } });
      expect(v.action).toBe('allow');
    });

    it('越界路径 → allow（bypass 免疫）', () => {
      const v = run({ mode: 'bypass', toolName: 'read_file', input: { path: join(root, '..', 'escape.txt') } });
      expect(v.action).toBe('allow');
    });
  });

  describe('default 模式', () => {
    it('只读工具工作区内 → allow', () => {
      expect(run({ toolName: 'read_file', input: { path: join(root, 'a.ts') }, isDangerous: false }).action).toBe('allow');
    });

    it('危险工具 bash（无 path）→ ask', () => {
      expect(run({ toolName: 'bash', isDangerous: true }).action).toBe('ask');
    });

    it('edit_file 普通文件（isDangerous=true）→ ask', () => {
      expect(run({ toolName: 'edit_file', input: { path: join(root, 'a.ts') }, isDangerous: true }).action).toBe('ask');
    });

    it('read_file 越界 → ask（path-guard）', () => {
      expect(run({ toolName: 'read_file', input: { path: join(root, '..', 'escape.txt') }, isDangerous: false }).action).toBe('ask');
    });

    it('read_file .env → ask（敏感文件）', () => {
      expect(run({ toolName: 'read_file', input: { path: join(root, '.env') }, isDangerous: false }).action).toBe('ask');
    });

    it('read_file .git/config → ask（危险目录）', () => {
      expect(run({ toolName: 'read_file', input: { path: join(root, '.git', 'config') }, isDangerous: false }).action).toBe('ask');
    });
  });

  describe('acceptEdits 模式', () => {
    it('edit_file 普通文件 → allow', () => {
      expect(run({ mode: 'acceptEdits', toolName: 'edit_file', input: { path: join(root, 'a.ts') }, isDangerous: true }).action).toBe('allow');
    });

    it('write_file 普通文件 → allow', () => {
      expect(run({ mode: 'acceptEdits', toolName: 'write_file', input: { path: join(root, 'b.ts') }, isDangerous: true }).action).toBe('allow');
    });

    it('edit_file .env → ask（敏感先于放行，path-guard step2 优先于 step4）', () => {
      expect(run({ mode: 'acceptEdits', toolName: 'edit_file', input: { path: join(root, '.env') }, isDangerous: true }).action).toBe('ask');
    });

    it('bash → ask（非编辑工具，不被 acceptEdits 放行）', () => {
      expect(run({ mode: 'acceptEdits', toolName: 'bash', isDangerous: true }).action).toBe('ask');
    });

    it('delete_file → ask（即使 acceptEdits，删除不在放行集）', () => {
      expect(run({ mode: 'acceptEdits', toolName: 'delete_file', input: { path: join(root, 'c.ts') }, isDangerous: true }).action).toBe('ask');
    });
  });

  describe('session allow_always 命中', () => {
    it('已批准工具 → allow（即使 dangerous）', () => {
      const allow = new AllowList();
      allow.add('bash');
      expect(run({ toolName: 'bash', isDangerous: true, allow }).action).toBe('allow');
    });

    it('已批准但路径越界 → 仍 ask（path-guard 优先于 allow）', () => {
      const allow = new AllowList();
      allow.add('edit_file');
      const v = run({ toolName: 'edit_file', input: { path: join(root, '..', 'escape.ts') }, isDangerous: true, allow });
      expect(v.action).toBe('ask');
    });
  });

  describe('verdict 携带 reason', () => {
    it('每个判定都有非空 reason（供日志/回喂）', () => {
      const cases = [
        run({ mode: 'bypass' }),
        run({ toolName: 'bash', isDangerous: true }),
        run({ toolName: 'read_file', input: { path: join(root, 'a.ts') }, isDangerous: false }),
        run({ mode: 'acceptEdits', toolName: 'edit_file', input: { path: join(root, 'a.ts') }, isDangerous: true }),
      ];
      for (const v of cases) {
        expect(typeof v.reason).toBe('string');
        expect(v.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe('deny 规则（settings.json 配置，阶段 4）', () => {
    const denyBashRm = { tool: 'bash', pattern: 'rm -rf *', action: 'deny' as const, source: 'user' as const };
    const denyEditEnv = { tool: 'edit_file', pattern: '.env', action: 'deny' as const, source: 'user' as const };
    const denyAllBash = { tool: 'bash', pattern: '*', action: 'deny' as const, source: 'project' as const };

    it('bash 命中 deny pattern（rm -rf /tmp）→ deny', () => {
      const v = run({ toolName: 'bash', input: { command: 'rm -rf /tmp' }, denyRules: [denyBashRm] });
      expect(v.action).toBe('deny');
    });

    it('bash deny：compound 含危险段（echo hi && rm -rf /x）→ deny（任一段命中即拒）', () => {
      const v = run({
        toolName: 'bash',
        input: { command: 'echo hi && rm -rf /x' },
        denyRules: [denyBashRm],
      });
      expect(v.action).toBe('deny');
    });

    it('bash 未命中 deny（ls -la）→ 不被 deny 拦（走后续 dangerous→ask）', () => {
      const v = run({ toolName: 'bash', input: { command: 'ls -la' }, denyRules: [denyBashRm] });
      expect(v.action).toBe('ask');
    });

    it('edit_file 命中 deny（.env）→ deny（path-guard 的 ask 被更强 deny 覆盖）', () => {
      const v = run({
        toolName: 'edit_file',
        input: { path: join(root, '.env') },
        isDangerous: true,
        denyRules: [denyEditEnv],
      });
      expect(v.action).toBe('deny');
    });

    it('工具名通配 deny（pattern=* 放行所有 bash）→ 所有 bash 命令 deny', () => {
      const v = run({ toolName: 'bash', input: { command: 'echo hi' }, denyRules: [denyAllBash] });
      expect(v.action).toBe('deny');
    });

    it('deny 规则不波及其他工具（deny bash 不影响 edit_file）', () => {
      const v = run({
        toolName: 'edit_file',
        input: { path: join(root, 'a.ts') },
        isDangerous: true,
        denyRules: [denyBashRm],
      });
      expect(v.action).toBe('ask'); // 未 deny，走 dangerous→ask
    });

    it('bypass 免疫 deny（即使配了 deny 规则，bypass 仍全放行）', () => {
      const v = run({
        mode: 'bypass',
        toolName: 'bash',
        input: { command: 'rm -rf /tmp' },
        denyRules: [denyBashRm],
      });
      expect(v.action).toBe('allow');
    });

    it('无 denyRules（undefined）→ 行为同阶段 2/3（不破坏现有语义）', () => {
      const v = run({ toolName: 'bash', input: { command: 'rm -rf /tmp' } });
      expect(v.action).toBe('ask'); // 无 deny 源 → 走 dangerous→ask（非 deny）
    });
  });
});
