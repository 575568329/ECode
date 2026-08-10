// 阶段2 Hooks：agent.ts 接线集成测试。
// 证明：① PreToolUse deny → 工具不执行 + deny 原因回喂 ② PostToolUse deny → 工具已执行 + 反馈追加
//      ③ 无 hooks → 字节级零回归（spy 正常执行、无 hook 文本）
// 关键：用 opts.hooksExec 注入 mock exec，免真 spawn（跨平台引号脆弱），与现有 mockProvider 模式一致。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { runAgentStream } from '../src/agent.js';
import { makeIsolatedRoot, isolatedOpts } from './helpers/isolated-dirs.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';
import type { ToolDefinition } from '../src/tools/types.js';

function mockProvider(parts: ECodeStreamPart[]): ModelProvider {
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '完成' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (_req: ChatRequest): AsyncIterable<ECodeStreamPart> {
      for (const p of parts) yield p;
    },
  };
}

const collect = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

/** mock exec：固定返回 exit 2（→ deny），捕获 stdin 便于断言。 */
const execDeny = vi.fn(async (_cmd: string, stdin: string) => ({
  stdout: '',
  stderr: JSON.parse(stdin).tool_name + ' 被 hook 拦',
  exitCode: 2,
}));

const spyTool = (spy: ReturnType<typeof vi.fn>): ToolDefinition => ({
  name: 'spy_tool',
  description: '测试桩工具',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: spy,
});

describe('runAgentStream Hooks 接线（阶段 2）', () => {
  let root: string;
  beforeEach(() => {
    root = makeIsolatedRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('PreToolUse deny → 工具不执行 + deny 原因回喂 LLM', async () => {
    const spy = vi.fn(async () => ({ content: '不该执行到这', isError: false }));
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'spy_tool' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(
      runAgentStream('测', {
        ...isolatedOpts(root),
        provider,
        tools: [spyTool(spy)],
        hooks: [
          { event: 'PreToolUse', command: 'mock', source: 'user', matcher: 'spy_tool' },
        ],
        hooksExec: execDeny,
      }),
    );
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain('hook 拒绝');
    expect(tr.content).toContain('spy_tool 被 hook 拦');
    // 🔴 关键：deny 后 executeTool 根本没被调用
    expect(spy).not.toHaveBeenCalled();
  });

  it('PostToolUse deny → 工具已执行 + 反馈追加回喂 LLM', async () => {
    const spy = vi.fn(async () => ({ content: '执行结果', isError: false }));
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'spy_tool' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(
      runAgentStream('测', {
        ...isolatedOpts(root),
        provider,
        tools: [spyTool(spy)],
        hooks: [
          { event: 'PostToolUse', command: 'mock', source: 'user', matcher: 'spy_tool' },
        ],
        hooksExec: execDeny,
      }),
    );
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    // 工具确实执行了（PostToolUse 在 executeTool 之后；mock provider 第二轮重放故 ≥1 次）
    expect(spy).toHaveBeenCalled();
    expect(tr.content).toContain('执行结果');
    expect(tr.content).toContain('[PostToolUse hook 反馈]');
    // isError 保持 false（工具成功，hook 只是反馈）
    expect(tr.isError).toBe(false);
  });

  it('PreToolUse modifiedInput → 改后输入喂给 executeTool', async () => {
    const seen = vi.fn(async (input: Record<string, unknown>) => ({
      content: JSON.stringify(input),
      isError: false,
    }));
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'spy_tool' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"ORIGINAL"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(
      runAgentStream('测', {
        ...isolatedOpts(root),
        provider,
        tools: [
          {
            name: 'spy_tool',
            description: 'd',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: seen,
          },
        ],
        hooks: [
          { event: 'PreToolUse', command: 'mock', source: 'user', matcher: 'spy_tool' },
        ],
        hooksExec: async () => ({
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: { path: 'MODIFIED' },
            },
          }),
          stderr: '',
          exitCode: 0,
        }),
      }),
    );
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    // 工具收到的是改后的 MODIFIED，不是 ORIGINAL
    expect(seen).toHaveBeenCalledWith({ path: 'MODIFIED' });
    expect(tr.content).toContain('MODIFIED');
  });

  it('无 hooks → 字节级零回归（工具正常执行、无 hook 文本）', async () => {
    const spy = vi.fn(async () => ({ content: '正常结果', isError: false }));
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'spy_tool' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(
      runAgentStream('测', { provider, ...isolatedOpts(root), tools: [spyTool(spy)] }),
    );
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(spy).toHaveBeenCalled();
    expect(tr.content).toBe('正常结果');
    expect(tr.isError).toBe(false);
    // 无 hook 注入痕迹
    expect(tr.content).not.toContain('hook');
  });

  it('Stop hook 打回 → push user reason + 多跑一轮后 completed', async () => {
    let stopCount = 0;
    // mock stream：纯文本 stop（无 tool_call）→ 命中 done 分支 → 触发 Stop hook
    const provider = mockProvider([
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(
      runAgentStream('测', {
        ...isolatedOpts(root),
        provider,
        tools: [],
        hooks: [{ event: 'Stop', command: 'mock', source: 'user' }],
        hooksExec: async () => {
          stopCount++;
          // 第一次 deny（打回），第二次 allow（放行完成）
          if (stopCount === 1) return { stdout: '', stderr: 'Stop 打回续跑', exitCode: 2 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }),
    );
    const done = events.find((e) => e.type === 'completed') as Extract<
      AgentEvent,
      { type: 'completed' }
    >;
    expect(done).toBeDefined();
    expect(done.reason).toBe('done');
    expect(done.rounds).toBe(2); // 打回后多跑一轮
    expect(stopCount).toBe(2); // Stop hook 跑两次：deny + allow
    // 打回 reason 作为 user 消息进了 messages（供 LLM 第二轮看到继续指令）
    expect(JSON.stringify(done.messages)).toContain('Stop 打回续跑');
  });

  it('Stop hook allow → 正常 completed（rounds=1，无打回）', async () => {
    let stopCount = 0;
    const provider = mockProvider([
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(
      runAgentStream('测', {
        ...isolatedOpts(root),
        provider,
        tools: [],
        hooks: [{ event: 'Stop', command: 'mock', source: 'user' }],
        hooksExec: async () => {
          stopCount++;
          return { stdout: '', stderr: '', exitCode: 0 }; // 恒 allow
        },
      }),
    );
    const done = events.find((e) => e.type === 'completed') as Extract<
      AgentEvent,
      { type: 'completed' }
    >;
    expect(done.reason).toBe('done');
    expect(done.rounds).toBe(1);
    expect(stopCount).toBe(1);
  });
});
