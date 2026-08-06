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

  it('LLM 流末带 usage → yield usage 事件（input/output tokens）', async () => {
    const provider = mockProvider([
      { type: 'text_delta', text: 'done' },
      { type: 'usage', inputTokens: 120, outputTokens: 30 },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect(usage?.type === 'usage' && usage.inputTokens).toBe(120);
    expect(usage?.type === 'usage' && usage.outputTokens).toBe(30);
  });

  it('多轮对话 → 每轮各 yield 一个 usage 事件（可累计）', async () => {
    // 第一轮：tool-use；第二轮：纯文本结束。
    // 用一个按 messages 长度返回不同流的自定义 provider
    let call = 0;
    const provider: ModelProvider = {
      name: 'mock',
      protocol: 'openai',
      baseURL: 'http://mock',
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: '压缩摘要' }],
        stopReason: { unified: 'stop' },
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      stream: async function* (req: ChatRequest): AsyncIterable<ECodeStreamPart> {
        call++;
        if (call === 1) {
          yield { type: 'tool_call_start', id: 't1', name: 'read_file' };
          yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"a"}' };
          yield { type: 'tool_call_end', id: 't1' };
          yield { type: 'usage', inputTokens: 100, outputTokens: 10 };
          yield { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } };
        } else {
          yield { type: 'text_delta', text: '好了' };
          yield { type: 'usage', inputTokens: 200, outputTokens: 20 };
          yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
        }
      },
    };
    const events = await collect(runAgentStream('读 a', { provider }));
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(2);
  });

  it('多个 text_delta chunk → 逐 chunk yield 为独立事件（R4 真流式）', async () => {
    // 回归 M3.5 R4：旧实现 consumeStream 把整轮 text 累加后只 yield 一次，
    // 导致 UI 动态区每轮只收到一坨完整文本，并不流式。改为逐 chunk yield 后，
    // 3 个 chunk 应产出 3 个独立 text_delta 事件，顺序与输入一致。
    const provider = mockProvider([
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
      { type: 'text_delta', text: '！' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(textDeltas).toHaveLength(3);
    expect(textDeltas.map((e) => e.text)).toEqual(['你', '好', '！']);
  });

  it('多 chunk 文本仍正确累积进 message 历史（assistant block.text 完整）', async () => {
    // R4 副作用校验：逐 chunk yield 不能破坏内部 message 累积——
    // 本轮 assistant 回复 push 进 messages 时 text 必须是完整拼接。
    // 通过第二轮 provider 收到的 messages 间接断言（assistant 上轮文本应为 '你好！'）。
    let call = 0;
    const seenMessages: unknown[] = [];
    const provider: ModelProvider = {
      name: 'mock',
      protocol: 'openai',
      baseURL: 'http://mock',
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: '压缩摘要' }],
        stopReason: { unified: 'stop' },
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      stream: async function* (req: ChatRequest): AsyncIterable<ECodeStreamPart> {
        call++;
        seenMessages.push(req.messages);
        if (call === 1) {
          // 第一轮：3 chunk 文本 + tool_call（不终止，进第二轮）
          yield { type: 'text_delta', text: '你' };
          yield { type: 'text_delta', text: '好' };
          yield { type: 'text_delta', text: '！' };
          yield { type: 'tool_call_start', id: 't1', name: 'read_file' };
          yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"a"}' };
          yield { type: 'tool_call_end', id: 't1' };
          yield { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } };
        } else {
          yield { type: 'text_delta', text: '完成' };
          yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
        }
      },
    };
    const events = await collect(runAgentStream('读 a', { provider }));
    expect(events.some((e) => e.type === 'completed')).toBe(true);
    // 第二轮收到的 messages 里，上轮 assistant 文本块应为完整 '你好！'
    const round2 = seenMessages[1] as Array<{ role: string; content: unknown }>;
    const assistantBlocks = round2.find((m) => m.role === 'assistant')?.content as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = assistantBlocks.find((b) => b.type === 'text');
    expect(textBlock?.text).toBe('你好！');
  });
});
