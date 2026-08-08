import { describe, it, expect, vi } from 'vitest';
import { runAgentStream } from '../../src/agent.js';
import type { AgentEvent } from '../../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider } from '../../src/providers/types.js';
import type { GateDecision } from '../../src/permission/types.js';
import type { PermissionGate } from '../../src/permission.js';

/**
 * 权限系统集成：check() 判定 + 三态 gate 接线 + 🔴-2 回归。
 * 关键回归——allow_once vs allow_always 在「同工具二次调用」上的差异：
 *   round1 内连续两个 bash tool_call：
 *     - allow_once：第二个仍触发 gate.ask（gate 调 2 次）
 *     - allow_always：第一个后 allow.add('bash')，第二个命中会话规则免问（gate 仅调 1 次）
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
});
