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

// 事件流钩子（SessionStart/SessionEnd/UserPromptSubmit/Stop）：非工具事件，无 matcher。
// agent 在生命周期各点 emit；Stop hook 返 deny → 打回续跑。聚合规则同 Pre/Post（deny>allow）。
describe('createHookGate - emit（事件流）', () => {
  it('Stop hook deny → decision deny + reason（agent 据此 push user 续跑）', async () => {
    const stopHook: HookDef = { event: 'Stop', command: 'c', source: 'user' };
    const gate = createHookGate([stopHook], { exec: execReturning('', 'Stop 打回续跑', 2) });
    const r = await gate.emit('Stop', { session_id: 's1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('Stop 打回续跑');
  });

  it('SessionStart hook → allow（事件通知，不拦）', async () => {
    let called = false;
    const startHook: HookDef = { event: 'SessionStart', command: 'c', source: 'user' };
    const gate = createHookGate([startHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const r = await gate.emit('SessionStart', { session_id: 's1' });
    expect(called).toBe(true);
    expect(r.decision).toBe('allow');
  });

  it('事件隔离：PreToolUse hook 不被 emit("SessionEnd") 触发', async () => {
    let called = false;
    const preHook: HookDef = {
      event: 'PreToolUse',
      command: 'c',
      source: 'user',
      matcher: 'Bash',
    };
    const gate = createHookGate([preHook], {
      exec: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await gate.emit('SessionEnd', { session_id: 's1' });
    expect(called).toBe(false);
  });

  it('无匹配 hook → allow（事件流默认放行）', async () => {
    const gate = createHookGate([]);
    expect((await gate.emit('Stop', { session_id: 's1' })).decision).toBe('allow');
  });

  it('多 Stop hook：deny 最严格胜出（即便前面 allow）', async () => {
    let i = 0;
    const gate = createHookGate(
      [
        { event: 'Stop', command: 'c1', source: 'user' },
        { event: 'Stop', command: 'c2', source: 'user' },
      ],
      {
        exec: async () => {
          i++;
          return i === 1
            ? { stdout: '{"decision":"approve"}', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '第二个打回', exitCode: 2 };
        },
      },
    );
    const r = await gate.emit('Stop', { session_id: 's1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('第二个打回');
  });
});
