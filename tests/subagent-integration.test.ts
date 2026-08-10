// 阶段1 子代理：端到端集成（主代理 → Task → 子代理递归 → 主代理综合）。
// 验证黑盒：子代理内部 tool 调用（read_file）不泄漏到主上下文；主只回收到 Task 的结论文本。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { runAgentStream } from '../src/agent.js';
import { makeIsolatedRoot, isolatedOpts } from './helpers/isolated-dirs.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';

/**
 * 顺序 provider：每次 stream() 调用消费 perCall 的下一个数组（模拟多轮 LLM 响应）。
 * 主代理 round1(Task) → 子代理 round1(read_file) → 子代理 round2(结论) → 主代理 round2(综合)。
 */
function sequentialProvider(perCall: ECodeStreamPart[][]): ModelProvider {
  let i = 0;
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '压缩摘要' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (_req: ChatRequest): AsyncIterable<ECodeStreamPart> {
      const parts = perCall[Math.min(i++, perCall.length - 1)];
      for (const p of parts) yield p;
    },
  };
}

const collect = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe('子代理端到端（主 → Task → 子递归 → 主综合）', () => {
  let root: string;
  beforeEach(() => {
    root = makeIsolatedRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('主代理调 Task → 子代理递归回收结论 → 主综合（黑盒：子内部 tool 不泄漏）', async () => {
    const provider = sequentialProvider([
      // ① 主 round1：派 Task
      [
        { type: 'tool_call_start', id: 'main-task', name: 'Task' },
        { type: 'tool_call_delta', id: 'main-task', inputDelta: '{"description":"d","prompt":"分析文件"}' },
        { type: 'tool_call_end', id: 'main-task' },
        { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
      ],
      // ② 子 round1：内部调 read_file（黑盒——这个调用不该出现在主上下文）
      [
        { type: 'tool_call_start', id: 'sub-read', name: 'read_file' },
        { type: 'tool_call_delta', id: 'sub-read', inputDelta: '{"path":"x"}' },
        { type: 'tool_call_end', id: 'sub-read' },
        { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
      ],
      // ③ 子 round2：给出结论
      [
        { type: 'text_delta', text: '子代理的结论' },
        { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
      ],
      // ④ 主 round2：综合
      [
        { type: 'text_delta', text: '主代理综合：子代理的结论' },
        { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
      ],
    ]);

    const events = await collect(
      runAgentStream('用子代理分析', { provider, ...isolatedOpts(root), model: 'glm-5.2' }),
    );

    // 主上下文：Task tool_result = 子代理结论（黑盒回收）
    const taskResult = events.find(
      (e) => e.type === 'tool_result' && e.name === 'Task',
    ) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(taskResult).toBeDefined();
    expect(taskResult.isError).toBe(false);
    expect(taskResult.content).toBe('子代理的结论');

    // 黑盒：子代理内部的 read_file 调用不泄漏到主上下文（主事件流里没有 read_file）
    const leakedRead = events.find(
      (e) => (e.type === 'tool_call_start' || e.type === 'tool_result') && e.name === 'read_file',
    );
    expect(leakedRead).toBeUndefined();

    // 主综合轮产出最终文本
    const finalText = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(finalText).toContain('主代理综合');
  });

  it('无 agents 目录 → Task 仍可派（默认继承主 system + 全工具），不崩', async () => {
    const provider = sequentialProvider([
      [
        { type: 'tool_call_start', id: 't', name: 'Task' },
        { type: 'tool_call_delta', id: 't', inputDelta: '{"description":"d","prompt":"p"}' },
        { type: 'tool_call_end', id: 't' },
        { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
      ],
      [{ type: 'text_delta', text: '默认结论' }, { type: 'stop', reason: { unified: 'stop', raw: 'stop' } }],
      [{ type: 'text_delta', text: 'done' }, { type: 'stop', reason: { unified: 'stop', raw: 'stop' } }],
    ]);
    const events = await collect(runAgentStream('派子代理', { provider, ...isolatedOpts(root), model: 'glm-5.2' }));
    const taskResult = events.find((e) => e.type === 'tool_result' && e.name === 'Task') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(taskResult).toBeDefined();
    expect(taskResult.content).toBe('默认结论');
  });
});
