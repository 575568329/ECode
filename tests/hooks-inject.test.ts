// 阶段2 Hooks：inject（gate 聚合）测试。
// 重点测 createHookGate：Pre/Post 决策聚合（deny 最严格胜出）+ matcher 命中规则。
import { describe, it, expect } from 'vitest';
import { createHookGate } from '../src/hooks/inject.js';
import type { HookDef } from '../src/hooks/types.js';

// 可注入 exec 工厂：返回固定结果，便于构造各场景
const execReturning = (stdout: string, stderr = '', exitCode = 0) => async () =>
  ({ stdout, stderr, exitCode });

describe('createHookGate - preToolUse', () => {
  const bashHook: HookDef = {
    event: 'PreToolUse',
    command: 'c',
    source: 'user',
    matcher: 'Bash',
  };

  it('deny hook → decision deny + reason', async () => {
    const gate = createHookGate([bashHook], {
      exec: execReturning('', '禁止危险命令', 2),
    });
    const r = await gate.preToolUse('bash', { command: 'rm -rf /' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('禁止危险命令');
  });

  it('allow hook → decision allow', async () => {
    const gate = createHookGate([bashHook], {
      exec: execReturning('{"decision":"approve"}'),
    });
    expect((await gate.preToolUse('bash', {})).decision).toBe('allow');
  });

  it('modifiedInput 透传（hook 改输入，CC hso.updatedInput）', async () => {
    const gate = createHookGate([bashHook], {
      exec: execReturning(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'ls -la' },
          },
        }),
      ),
    });
    const r = await gate.preToolUse('bash', { command: 'ls' });
    expect(r.modifiedInput).toEqual({ command: 'ls -la' });
  });

  it('matcher 只命中匹配工具（Edit hook 不拦 bash）', async () => {
    let called = false;
    const editHook: HookDef = {
      event: 'PreToolUse',
      command: 'c',
      source: 'user',
      matcher: 'Edit',
    };
    const gate = createHookGate([editHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await gate.preToolUse('bash', {});
    expect(called).toBe(false);
  });

  it('matcher 大小写不敏感（Bash 匹配 bash）', async () => {
    let called = false;
    const gate = createHookGate([bashHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await gate.preToolUse('bash', {});
    expect(called).toBe(true);
  });

  it('无 matcher = "*" 命中全部工具', async () => {
    let called = false;
    const allHook: HookDef = {
      event: 'PreToolUse',
      command: 'c',
      source: 'user',
    };
    const gate = createHookGate([allHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await gate.preToolUse('any_tool', {});
    expect(called).toBe(true);
  });

  it('多 hook：deny 最严格胜出（即便前面 allow）', async () => {
    let i = 0;
    const gate = createHookGate([bashHook, { ...bashHook, command: 'c2' }], {
      exec: async () => {
        i++;
        return i === 1
          ? { stdout: '{"decision":"approve"}', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '第二个拦了', exitCode: 2 };
      },
    });
    const r = await gate.preToolUse('bash', {});
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('第二个拦了');
  });
});

describe('createHookGate - postToolUse', () => {
  const postHook: HookDef = {
    event: 'PostToolUse',
    command: 'c',
    source: 'user',
    matcher: 'Bash',
  };

  it('deny hook → decision deny + reason（agent 据此把反馈回喂 LLM）', async () => {
    const gate = createHookGate([postHook], {
      exec: execReturning('', '不该 push 到 main', 2),
    });
    const r = await gate.postToolUse('bash', { command: 'git push' }, '已推送');
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('不该 push 到 main');
  });

  it('事件隔离：PreToolUse hook 不在 postToolUse 触发', async () => {
    const preHook: HookDef = {
      event: 'PreToolUse',
      command: 'c',
      source: 'user',
      matcher: 'Bash',
    };
    let called = false;
    const gate = createHookGate([preHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await gate.postToolUse('bash', {}, 'out');
    expect(called).toBe(false);
  });

  it('无匹配 hook → allow（放行，不阻塞）', async () => {
    const gate = createHookGate([]);
    expect((await gate.postToolUse('bash', {}, 'out')).decision).toBe('allow');
  });
});
