import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { OpenAIProvider } from '../../src/providers/openai.js';
import type { ChatRequest } from '../../src/providers/types.js';

const baseReq: ChatRequest = {
  model: 'glm-test',
  system: '你是 ECode',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

describe('OpenAIProvider', () => {
  beforeEach(() => mockCreate.mockReset());

  it('调 chat.completions.create 并把响应翻译成 ECode 格式', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        { message: { content: '你好' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
    const provider = new OpenAIProvider({ apiKey: 'fake-key' });
    const r = await provider.complete(baseReq);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(r.stopReason.unified).toBe('stop');
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it('请求参数经 transform：system 塞 messages[0]（role:system）', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const provider = new OpenAIProvider({ apiKey: 'fake' });
    await provider.complete(baseReq);
    const arg = mockCreate.mock.calls[0]?.[0] as { messages?: Array<{ role: string; content: string }> };
    expect(arg.messages?.[0]).toEqual({ role: 'system', content: '你是 ECode' });
  });

  it('工具调用响应正确翻译（tool_calls + arguments JSON 字符串 → tool_call.input 对象）', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new OpenAIProvider({ apiKey: 'fake' });
    const r = await provider.complete(baseReq);
    expect(r.content[0]).toEqual({ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'x' } });
    expect(r.stopReason.unified).toBe('tool-use');
  });
});
