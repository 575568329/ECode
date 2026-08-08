import { describe, it, expect, vi } from 'vitest';
import { runAgentStream } from '../../src/agent.js';
import type { AgentEvent } from '../../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider } from '../../src/providers/types.js';
import type { GateDecision } from '../../src/permission/types.js';
import type { PermissionGate } from '../../src/permission.js';

/**
 * 权限系统集成：check() 判定 + 三态 gate 接线 + 🔴-2 回归 + bash 命令分级。
 * 关键回归——allow_once vs allow_always 在「同工具二次调用」上的差异：
 *   round1 内连续两个 bash tool_call（echo one / echo two，均归约到 echo *）：
 *     - allow_once：不记会话规则，第二个仍触发 gate.ask（gate 调 2 次）
 *     - allow_always：第一个后 addBashPattern('echo *')，第二个命中 pattern 免问（gate 仅调 1 次）
 */

/** mock provider：round1 yield 给定 tool_call parts（末尾 stop tool-use 触发下一轮），round2 文本终止。 */
function twoRoundProvider(toolCallParts: ECodeStreamPart[]): ModelProvider {
  let call = 0;
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '摘要' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (): AsyncIterable<ECodeStreamPart> {
      call++;
      if (call === 1) {
        for (const p of toolCallParts) yield p;
      } else {
        yield { type: 'text_delta', text: '完成' };
        yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
      }
    },
  };
}

/** 构造一个 bash tool_call 的 chunk 序列（dangerous，default 下必触发 ask）。 */
function bashCall(id: string, command: string): ECodeStreamPart[] {
  return [
    { type: 'tool_call_start', id, name: 'bash' },
    { type: 'tool_call_delta', id, inputDelta: JSON.stringify({ command }) },
    { type: 'tool_call_end', id },
    { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } },
  ];
}

/** 构造一个 edit_file tool_call（M4 缺口修复后 dangerous:true，default 下触发 ask）。 */
function editCall(id: string): ECodeStreamPart[] {
  return [
    { type: 'tool_call_start', id, name: 'edit_file' },
    {
      type: 'tool_call_delta',
      id,
      inputDelta: JSON.stringify({ path: 'ecode-nonexistent-perm-test.ts', oldText: 'x', newText: 'y' }),
    },
    { type: 'tool_call_end', id },
    { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } },
  ];
}

/** 固定返回某决策的 gate。 */
function gateReturning(decision: GateDecision): PermissionGate {
  return { ask: vi.fn(async () => decision) };
}

/** 连续 N 轮都跑同一条 bash 命令（每轮 tool-use stop 触发下一轮），第 N+1 轮文本终止。用于 doom_loop。 */
function repeatBashProvider(rounds: number, command: string): ModelProvider {
  let call = 0;
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '摘要' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (): AsyncIterable<ECodeStreamPart> {
      call++;
      if (call <= rounds) {
        for (const p of bashCall(`t${call}`, command)) yield p; // 末尾 tool-use stop → 下一轮
      } else {
        yield { type: 'text_delta', text: '完成' };
        yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
      }
    },
  };
}

/** 每轮跑不同 bash 命令（commands[call-1]），用于 doom_loop 对照（输入变化 → 不触发）。 */
function varyingBashProvider(commands: string[]): ModelProvider {
  let call = 0;
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '摘要' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (): AsyncIterable<ECodeStreamPart> {
      const cmd = commands[call];
      call++;
      if (cmd !== undefined) {
        for (const p of bashCall(`t${call}`, cmd)) yield p;
      } else {
        yield { type: 'text_delta', text: '完成' };
        yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
      }
    },
  };
}

/** round1 内连续两个 bash tool_call（共享末尾一个 stop）。用于「同会话二次调用」场景。 */
function twoBash(id1: string, cmd1: string, id2: string, cmd2: string): ECodeStreamPart[] {
  return [
    ...bashCall(id1, cmd1).slice(0, 3), // 去掉各 call 末尾的 stop
    ...bashCall(id2, cmd2).slice(0, 3),
    { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } },
  ];
}

const collect = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe('权限系统集成（check + 三态 gate）', () => {
  it('危险工具（bash）default 模式 → yield permission_request 事件', async () => {
    const provider = twoRoundProvider(bashCall('t1', 'echo hi'));
    const gate = gateReturning('allow_once');
    const events = await collect(runAgentStream('跑', { provider, permissionGate: gate }));
    expect(events.some((e) => e.type === 'permission_request')).toBe(true);
    const req = events.find((e) => e.type === 'permission_request') as Extract<
      AgentEvent,
      { type: 'permission_request' }
    >;
    expect(req.toolName).toBe('bash');
    expect(gate.ask).toHaveBeenCalled();
  });

  it('edit_file default 模式触发询问（registry dangerous 缺口已修复）', async () => {
    // 回归：旧 registry edit_file 无 dangerous 标志 → 编辑文件不弹窗（缺口）。
    // 加 dangerous:true 后，default 模式 check() 应返回 ask → 调 gate。
    const provider = twoRoundProvider(editCall('t1'));
    const gate = gateReturning('allow_once');
    await collect(runAgentStream('编辑', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(1);
  });

  it('gate 返回 deny → tool_result isError + "用户拒绝"，且不执行该工具', async () => {
    const provider = twoRoundProvider(bashCall('t1', 'echo hi'));
    const gate = gateReturning('deny');
    const events = await collect(runAgentStream('跑', { provider, permissionGate: gate }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain('用户拒绝');
    // deny 分支 continue 在 tool_call_start 之前 → 不应出现该工具的 tool_call_start
    expect(events.some((e) => e.type === 'tool_call_start' && e.name === 'bash')).toBe(false);
  });

  it('🔴-2 回归：allow_once → 同工具再次调用仍询问（gate.ask 调 2 次）', async () => {
    // round1 连续两个 bash：allow_once 不记会话规则，第二个仍触发 gate。
    const provider = twoRoundProvider([
      ...bashCall('t1', 'echo one').slice(0, 3), // 去掉末尾 stop
      ...bashCall('t2', 'echo two').slice(0, 3),
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } },
    ]);
    const gate = gateReturning('allow_once');
    await collect(runAgentStream('跑两次', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(2);
  });

  it('🔴-2 回归：allow_always → 同工具再次调用免询问（gate.ask 仅调 1 次）', async () => {
    // round1 连续两个 bash：allow_always 记 allow.add('bash')，第二个命中会话规则免问。
    const provider = twoRoundProvider([
      ...bashCall('t1', 'echo one').slice(0, 3),
      ...bashCall('t2', 'echo two').slice(0, 3),
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } },
    ]);
    const gate = gateReturning('allow_always');
    await collect(runAgentStream('跑两次', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(1);
  });

  it('无 gate → 危险工具默认放行执行（兼容无 UI / 测试）', async () => {
    const provider = twoRoundProvider(bashCall('t1', 'echo hi'));
    // 不传 permissionGate
    const events = await collect(runAgentStream('跑', { provider }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.isError).toBe(false); // bash echo 执行成功
  });

  it('acceptEdits 模式 → edit_file 免询问直接执行（不调 gate）', async () => {
    const provider = twoRoundProvider(editCall('t1'));
    const gate = gateReturning('allow_always');
    const events = await collect(
      runAgentStream('编辑', { provider, permissionGate: gate, permissionMode: 'acceptEdits' }),
    );
    expect(gate.ask).not.toHaveBeenCalled(); // acceptEdits 放行编辑工具，不经 gate
    expect(events.some((e) => e.type === 'permission_request')).toBe(false);
  });

  it('bypass 模式 → 危险工具免询问直接执行（不调 gate）', async () => {
    const provider = twoRoundProvider(bashCall('t1', 'echo hi'));
    const gate = gateReturning('allow_always');
    const events = await collect(
      runAgentStream('跑', { provider, permissionGate: gate, permissionMode: 'bypass' }),
    );
    expect(gate.ask).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'permission_request')).toBe(false);
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr?.isError).toBe(false);
  });

  // ── 阶段 3：bash 命令分级（arity 归约 + 命令 pattern） ──
  // 注：allow_always 后命令会「真实执行」，故用只读 git 命令（git status/log/diff，瞬时无害、
  //   git 在本仓库必可用）演示 pattern 逻辑；刻意避开 npm install（分钟级）/ git push（卡网络）
  //   / rm -rf（破坏性），它们在 allow_always 下会被执行导致超时或副作用。

  it('bash 命令分级：allow_always git status → 生成 git status *，下次 git status -s 免询问', async () => {
    // 'git status' 归约保留（git arity=2），allow_always 生成 pattern 'git status *'。
    // 同会话再跑 'git status -s' 命中 pattern → 免询问（gate 仅调 1 次）。
    const provider = twoRoundProvider(twoBash('t1', 'git status', 't2', 'git status -s'));
    const gate = gateReturning('allow_always');
    await collect(runAgentStream('跑两次', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(1);
  });

  it('bash 命令分级：git status * 不放行 git log（不同 pattern 仍询问）', async () => {
    // 'git log' 不匹配 'git status *' → 仍询问（gate 调 2 次）。
    // 证明 bash 不再「整工具放行」，而是按命令前缀分级。
    const provider = twoRoundProvider(twoBash('t1', 'git status', 't2', 'git log'));
    const gate = gateReturning('allow_always');
    await collect(runAgentStream('跑两次', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(2);
  });

  it('compound 防绕过：allow_always git status 后跑 git status && git log 仍询问', async () => {
    // git log 段未批准 → 整条 ask。证明复合命令逐段审批，不被 'git status *' 贪婪放行（compound bypass 防护）。
    const provider = twoRoundProvider(twoBash('t1', 'git status', 't2', 'git status && git log'));
    const gate = gateReturning('allow_always');
    await collect(runAgentStream('跑复合', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(2);
  });

  it('compound 全段批准 → 放行：allow_always git status 后跑 git status -s && git status -b 免询问', async () => {
    // 两段都命中 'git status *' → 整条 allow（gate 仅调 1 次）。对照上一条，证明全段命中才放行。
    const provider = twoRoundProvider(twoBash('t1', 'git status', 't2', 'git status -s && git status -b'));
    const gate = gateReturning('allow_always');
    await collect(runAgentStream('跑复合', { provider, permissionGate: gate }));
    expect(gate.ask).toHaveBeenCalledTimes(1);
  });

  // ── 阶段 5b：reject 反馈回喂 LLM ──
  it('5b：gate 返回 {decision:deny, feedback} → tool_result 含反馈文本（回喂 LLM）', async () => {
    const provider = twoRoundProvider(bashCall('t1', 'echo hi'));
    const gate: PermissionGate = {
      ask: vi.fn(async () => ({ decision: 'deny' as const, feedback: '别用 rm' })),
    };
    const events = await collect(runAgentStream('跑', { provider, permissionGate: gate }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain('别用 rm'); // 反馈拼进 denied 回喂
    expect(tr.content).toContain('反馈');
  });

  // ── 阶段 5d：doom_loop 检测 ──
  // 注：echo hi 在 allow_once 下会真实执行（瞬时无害，与「无 gate」用例一致）。
  it('5d：连续 3 次相同 bash 调用 → 第 3 次触发 warning + permission_request 带 reason', async () => {
    const provider = repeatBashProvider(3, 'echo hi');
    const gate = gateReturning('allow_once');
    const events = await collect(runAgentStream('死循环', { provider, permissionGate: gate }));
    // 第 3 次（count=3）触发 doom：发 warning 事件
    const warnings = events.filter((e) => e.type === 'warning') as Extract<
      AgentEvent,
      { type: 'warning' }
    >[];
    expect(warnings.some((w) => w.message.includes('死循环'))).toBe(true);
    // 第 3 次的 permission_request 带 reason
    const doomReq = events.find(
      (e) => e.type === 'permission_request' && e.reason,
    ) as Extract<AgentEvent, { type: 'permission_request' }> | undefined;
    expect(doomReq?.reason).toContain('死循环');
    // gate 3 次（每轮 allow_once 都问；第 3 次 doom 强制 ask 也是 ask）
    expect(gate.ask).toHaveBeenCalledTimes(3);
  });

  it('5d：不同输入不触发 doom（第 3 次换命令 → 无 reason、无死循环 warning）', async () => {
    // 命令逐轮变化 → doom 计数每轮重置，第 3 轮 count=1，不触发。
    const provider = varyingBashProvider(['echo a', 'echo b', 'echo c']);
    const gate = gateReturning('allow_once');
    const events = await collect(runAgentStream('不重复', { provider, permissionGate: gate }));
    const warnings = events.filter((e) => e.type === 'warning') as Extract<
      AgentEvent,
      { type: 'warning' }
    >[];
    expect(warnings.some((w) => w.message.includes('死循环'))).toBe(false);
    expect(events.some((e) => e.type === 'permission_request' && e.reason)).toBe(false);
  });
});
