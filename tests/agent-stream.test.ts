import { describe, it, expect, vi } from 'vitest';
import { runAgentStream } from '../src/agent.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';

/** 造一个返回固定 chunk 流的 mock provider（complete 给桩，summarize 压缩时用）。 */
function mockProvider(parts: ECodeStreamPart[]): ModelProvider {
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
      for (const p of parts) yield p;
    },
  };
}

const collect = async (gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe('runAgentStream', () => {
  it('纯文本回复 → start / text_delta / completed(done)', async () => {
    const provider = mockProvider([
      { type: 'text_delta', text: '你好' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    expect(events[0].type).toBe('start');
    expect(events.some((e) => e.type === 'text_delta' && e.text === '你好')).toBe(true);
    const done = events.find((e) => e.type === 'completed');
    expect(done?.type === 'completed' && done.reason).toBe('done');
  });

  it('工具调用 → tool_call_start / tool_result 事件序列正确', async () => {
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"package.json"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    // 简化：只测第一轮事件，不构造完整多轮（多轮需 provider 按 messages 返回不同流）
    const events = await collect(runAgentStream('读 package.json', { provider }));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_result');
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr.id).toBe('t1');
    expect(tr.name).toBe('read_file');
  });

  it('text + tool_call 同时出现 → text_delta 在 tool_call_start 之前 yield（事件流完整性）', async () => {
    // 回归：LLM 常见模式"让我读取 package.json" + tool_call，text 必须作为事件流出
    const provider = mockProvider([
      { type: 'text_delta', text: '让我读取 package.json' },
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"package.json"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('读 package.json', { provider }));
    const textIdx = events.findIndex((e) => e.type === 'text_delta');
    const toolStartIdx = events.findIndex((e) => e.type === 'tool_call_start');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeGreaterThan(textIdx); // text 在 tool_call_start 之前
    const td = events[textIdx] as Extract<AgentEvent, { type: 'text_delta' }>;
    expect(td.text).toBe('让我读取 package.json');
  });
});
