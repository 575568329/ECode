// 阶段2 Hooks：system-hooks（系统 hook 强制叠加）测试。
// 核心：getEffectiveHooks 不变量——系统 hook 恒前置，用户配置无法移除。
import { describe, it, expect } from 'vitest';
import { SYSTEM_HOOKS, getEffectiveHooks } from '../src/hooks/system-hooks.js';
import type { HookDef } from '../src/hooks/types.js';

describe('getEffectiveHooks（系统 hook 强制叠加不变量）', () => {
  it('系统 hook 恒前置 + 用户 hook 追加在后', () => {
    const user: HookDef[] = [
      { event: 'PreToolUse', command: 'user-cmd', source: 'user', matcher: 'Bash' },
    ];
    const eff = getEffectiveHooks(user);
    expect(eff.length).toBe(SYSTEM_HOOKS.length + user.length);
    // 系统 hook 必须排在用户 hook 之前
    expect(eff.slice(0, SYSTEM_HOOKS.length)).toEqual(SYSTEM_HOOKS);
    expect(eff[SYSTEM_HOOKS.length]).toEqual(user[0]);
  });

  it('用户 hook 为空 → 返回纯系统 hook', () => {
    expect(getEffectiveHooks([])).toEqual(SYSTEM_HOOKS);
  });

  it('用户配置无法移除系统 hook（系统 count 恒定）', () => {
    const user: HookDef[] = [
      { event: 'PreToolUse', command: 'x', source: 'user' },
      { event: 'PostToolUse', command: 'y', source: 'user' },
    ];
    const eff = getEffectiveHooks(user);
    const sysCount = eff.filter((h) => h.source === 'system').length;
    expect(sysCount).toBe(SYSTEM_HOOKS.length);
  });

  it('系统 hook source 标记为 system', () => {
    for (const h of SYSTEM_HOOKS) {
      expect(h.source).toBe('system');
    }
  });
});
