import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock mock 模块（知识缺口 #2）：用 vi.hoisted 提升 mockCreate/mockStream 引用，
// 让 vi.mock 工厂和测试共享同一个 mock 函数。
const { mockCreate, mockStream } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockStream: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    // Anthropic 实例的 messages.create / messages.stream 被替换成 mock
    messages = { create: mockCreate, stream: mockStream };
  },
}));

import { ClaudeProvider } from '../../src/providers/claude.js';
import type { ChatRequest } from '../../src/providers/types.js';

const baseReq: ChatRequest = {
  model: 'claude-test',
  system: '你是 ECode',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

describe('ClaudeProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('调 messages.create 并把响应翻译成 ECode 格式', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '你好' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    const provider = new ClaudeProvider({ apiKey: 'fake-key' });
    const r = await provider.complete(baseReq);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(r.stopReason.unified).toBe('stop');
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it('请求参数经 transform 翻译：system 在顶层、model 透传', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const provider = new ClaudeProvider({ apiKey: 'fake' });
    await provider.complete(baseReq);
    const arg = mockCreate.mock.calls[0]?.[0] as { system?: string; model?: string };
    expect(arg.system).toBe('你是 ECode');
    expect(arg.model).toBe('claude-test');
  });

  it('工具调用响应正确翻译（tool_use → tool_call）', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new ClaudeProvider({ apiKey: 'fake' });
    const r = await provider.complete(baseReq);
    expect(r.content[0]).toEqual({ type: 'tool_call', id: 't1', name: 'read', input: { path: 'x' } });
    expect(r.stopReason.unified).toBe('tool-use');
  });

  it('stream() 把 Anthropic 事件流翻译成 ECodeStreamPart', async () => {
    // SDK 0.32.1 真实行为：messages.stream() 同步返回 MessageStream（本身即 AsyncIterable<RawMessageStreamEvent>）。
    // mock 用 mockReturnValue 返回一个 async generator，与生产同构（同步返回 AsyncIterable）。
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    ];
    mockStream.mockReturnValue(
      (async function* () {
        for (const e of events) yield e;
      })(),
    );
    const provider = new ClaudeProvider({ apiKey: 'fake' });
    const parts = [];
    for await (const p of provider.stream(baseReq)) parts.push(p);
    const types = parts.map((p) => p.type);
    // message_delta yields usage first, then stop；text/tool 各自走 start/delta/end
    expect(types).toEqual([
      'text_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'stop',
    ]);
    const start = parts.find((p) => p.type === 'tool_call_start');
    expect(start).toMatchObject({ id: 't1', name: 'read_file' });
  });
});
