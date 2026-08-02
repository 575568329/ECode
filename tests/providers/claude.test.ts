import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock mock 模块（知识缺口 #2）：用 vi.hoisted 提升 mockCreate 引用，
// 让 vi.mock 工厂和测试共享同一个 mock 函数。
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    // Anthropic 实例的 messages.create 被替换成 mockCreate
    messages = { create: mockCreate };
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
  beforeEach(() => mockCreate.mockReset());

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
    expect(r.stopReason).toBe('end_turn');
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
    expect(r.stopReason).toBe('tool_use');
  });
});
