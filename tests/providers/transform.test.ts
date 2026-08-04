import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  toAnthropicRequest,
  fromAnthropicResponse,
  toOpenAIMessages,
  fromOpenAIResponse,
} from '../../src/providers/transform.js';
import type { ChatRequest } from '../../src/providers/types.js';

const baseRequest: ChatRequest = {
  model: 'test-model',
  system: '你是 ECode',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

describe('toAnthropicRequest', () => {
  it('system 放顶层字段，不进 messages', () => {
    const r = toAnthropicRequest(baseRequest);
    expect(r.system).toBe('你是 ECode');
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('tools 翻译成 input_schema 格式，空 tools 时为 undefined', () => {
    expect(toAnthropicRequest(baseRequest).tools).toBeUndefined();
    const req: ChatRequest = {
      ...baseRequest,
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }],
    };
    expect(req.tools && toAnthropicRequest(req).tools?.[0]).toMatchObject({
      name: 'read',
      input_schema: { type: 'object' },
    });
  });

  it('tool_call/tool_result block 翻译成 tool_use/tool_result', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'read', input: { path: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: '结果' } }] },
      ],
    };
    const r = toAnthropicRequest(req);
    expect(r.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] });
    expect(r.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] });
  });

  it('v2: tool_result error output → is_error: true', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'error', value: '文件不存在' } }] },
      ],
    };
    const r = toAnthropicRequest(req);
    const block = (r.messages[0] as { content: Array<{ type: string; is_error?: boolean }> }).content[0];
    expect(block.is_error).toBe(true);
  });

  it('v2: tool_result text output → is_error 不存在', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: 'ok' } }] },
      ],
    };
    const r = toAnthropicRequest(req);
    const block = (r.messages[0] as { content: Array<{ type: string; is_error?: boolean }> }).content[0];
    expect(block.is_error).toBeUndefined();
  });
});

describe('fromAnthropicResponse', () => {
  it('text + tool_use → ECode block；thinking 忽略；stop_reason 映射', () => {
    const fakeRes = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } },
        { type: 'thinking', thinking: '...', signature: 's' },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as unknown as Anthropic.Message;
    const r = fromAnthropicResponse(fakeRes);
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(r.content[1]).toEqual({ type: 'tool_call', id: 't1', name: 'read', input: { path: 'x' } });
    expect(r.stopReason.unified).toBe('tool-use');
    expect(r.stopReason.raw).toBe('tool_use');
    expect(r.warnings).toEqual([{ type: 'unsupported', feature: "content block type 'thinking'" }]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('stop_reason end_turn → end_turn', () => {
    const fakeRes = {
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
    expect(fromAnthropicResponse(fakeRes).stopReason.unified).toBe('stop');
    expect(fromAnthropicResponse(fakeRes).stopReason.raw).toBe('end_turn');
  });
});

describe('toOpenAIMessages', () => {
  it('system 塞进 messages[0]（role:system）', () => {
    const msgs = toOpenAIMessages(baseRequest);
    expect(msgs[0]).toEqual({ role: 'system', content: '你是 ECode' });
  });

  it('tool_result → 独立 role:tool 消息（ECode user → OpenAI tool）', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', output: { type: 'text', value: '结果' } }] }],
    };
    const msgs = toOpenAIMessages(req);
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '结果' });
  });

  it('v2: tool_result error output → OpenAI tool content 保留错误文本', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', output: { type: 'error', value: '命令执行失败' } }] }],
    };
    const msgs = toOpenAIMessages(req);
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '命令执行失败' });
  });

  it('v2: tool_result json output → OpenAI tool content 序列化为 JSON 字符串', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', output: { type: 'json', value: { files: 3, lines: 120 } } }] }],
    };
    const msgs = toOpenAIMessages(req);
    expect(msgs[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"files":3,"lines":120}' });
  });

  it('assistant tool_call → tool_calls 字段，input 序列化成 JSON 字符串', () => {
    const req: ChatRequest = {
      ...baseRequest,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '想一下' },
            { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'x' } },
          ],
        },
      ],
    };
    const msgs = toOpenAIMessages(req);
    const assistant = msgs[1] as {
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: 'c1',
      function: { name: 'read', arguments: '{"path":"x"}' },
    });
  });
});

describe('fromOpenAIResponse', () => {
  it('content + tool_calls → ECode，arguments JSON 字符串 parse 成对象', () => {
    const fakeRes = {
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 8 },
    } as unknown as OpenAI.Chat.ChatCompletion;
    const r = fromOpenAIResponse(fakeRes);
    expect(r.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(r.content[1]).toEqual({ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'x' } });
    expect(r.stopReason.unified).toBe('tool-use');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 8 });
  });

  it('finish_reason stop → end_turn；usage 缺失时为 0', () => {
    const fakeRes = {
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    } as unknown as OpenAI.Chat.ChatCompletion;
    const r = fromOpenAIResponse(fakeRes);
    expect(r.stopReason.unified).toBe('stop');
    expect(r.stopReason.raw).toBe('stop');
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
