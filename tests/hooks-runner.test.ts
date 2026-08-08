// 阶段2 Hooks：runner 测试。
// 重点测纯解析 parseHookOutput（CC 协议三通道）+ runHook（可注入 exec，含超时/失败降级）。
import { describe, it, expect } from 'vitest';
import { parseHookOutput, runHook } from '../src/hooks/runner.js';
import type { HookDef, HookPayload } from '../src/hooks/types.js';

describe('parseHookOutput（纯解析，CC 协议）', () => {
  it('exit code 2 → deny（stderr 当 reason）', () => {
    const r = parseHookOutput('', 2, '危险操作被拦');
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('危险操作被拦');
  });

  it('exit code 2 无 stderr → deny 带默认 reason', () => {
    const r = parseHookOutput('', 2);
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('exit code 2');
  });

  it('stdout JSON 顶层 decision:approve → allow', () => {
    const r = parseHookOutput(JSON.stringify({ decision: 'approve' }), 0);
    expect(r.decision).toBe('allow');
  });

  it('stdout JSON 顶层 decision:block → deny（block=deny）', () => {
    const r = parseHookOutput(JSON.stringify({ decision: 'block', reason: '不让做' }), 0);
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('不让做');
  });

  it('结构化嵌套 hookSpecificOutput.permissionDecision=deny → deny + reason', () => {
    const r = parseHookOutput(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '策略禁止',
        },
      }),
      0,
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('策略禁止');
  });

  it('结构化嵌套 updatedInput → modifiedInput 透传（PreToolUse 改输入）', () => {
    const r = parseHookOutput(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'ls -la' },
        },
      }),
      0,
    );
    expect(r.decision).toBe('allow');
    expect(r.modifiedInput).toEqual({ command: 'ls -la' });
  });

  it('非 JSON stdout + exit 0 → allow（放行）', () => {
    expect(parseHookOutput('一些日志输出', 0).decision).toBe('allow');
  });

  it('空 stdout + exit 0 → allow', () => {
    expect(parseHookOutput('', 0).decision).toBe('allow');
  });
});

describe('runHook（可注入 exec）', () => {
  const def: HookDef = { event: 'PreToolUse', command: 'echo hi', source: 'user', matcher: 'Bash' };
  const payload: HookPayload = { tool_name: 'bash', tool_input: { command: 'rm -rf /' } };

  it('exec 返回 exit 2 → deny', async () => {
    const r = await runHook(def, payload, {
      exec: async () => ({ stdout: '', stderr: '拦', exitCode: 2 }),
    });
    expect(r.decision).toBe('deny');
  });

  it('exec 返回 exit 0 + approve JSON → allow', async () => {
    const r = await runHook(def, payload, {
      exec: async () => ({ stdout: '{"decision":"approve"}', stderr: '', exitCode: 0 }),
    });
    expect(r.decision).toBe('allow');
  });

  it('exec 抛错（spawn 失败/超时）→ 默认 allow（降级不杀 agent）', async () => {
    const r = await runHook(def, payload, {
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(r.decision).toBe('allow');
  });

  it('喂给 exec 的 stdin 是 payload 的 JSON', async () => {
    let captured = '';
    await runHook(def, payload, {
      exec: async (_cmd, stdin) => {
        captured = stdin;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    expect(JSON.parse(captured)).toEqual(payload);
  });
});
