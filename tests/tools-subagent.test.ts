// 阶段1 子代理：Task 工具（createTaskTool）测试。
// 覆盖：extractFinalText 取末尾 assistant 文本；深度超限拒绝派发；递归回收结论（黑盒）。
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool, extractFinalText } from '../src/tools/subagent.js';
import { AllowList } from '../src/permission.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeMessage, ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';

/** mock provider：stream 产出固定 chunk 流（同 agent-stream.test.ts 模式）。 */
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

const textMsg = (text: string): ECodeMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

describe('extractFinalText', () => {
  it('取末尾 assistant 的 text', () => {
    const msgs: ECodeMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, textMsg('final answer')];
    expect(extractFinalText(msgs)).toBe('final answer');
  });

  it('跳过 tool_use，只取 text 块', () => {
    const msgs: ECodeMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }] },
      textMsg('conclusion'),
    ];
    expect(extractFinalText(msgs)).toBe('conclusion');
  });

  it('取「最末」assistant（多个 assistant 时取最后一条）', () => {
    const msgs: ECodeMessage[] = [textMsg('first'), textMsg('second')];
    expect(extractFinalText(msgs)).toBe('second');
  });

  it('无 assistant text → 空串', () => {
    expect(extractFinalText([{ role: 'user', content: [{ type: 'text', text: 'q' }] }])).toBe('');
  });
});

describe('createTaskTool', () => {
  it('是名为 Task 的 dangerous 工具', () => {
    const tool = createTaskTool({ system: 's', allow: new AllowList(), getPermissionMode: () => 'default', depth: 0 });
    expect(tool.name).toBe('Task');
    expect(tool.dangerous).toBe(true);
    expect(tool.execute).toBeDefined();
  });

  it('深度超限 → isError 拒绝派发，不递归（防递归爆炸）', async () => {
    const provider = mockProvider([{ type: 'text_delta', text: '不应被调用' }, { type: 'stop', reason: { unified: 'stop', raw: 'stop' } }]);
    const tool = createTaskTool({ system: 's', allow: new AllowList(), getPermissionMode: () => 'default', provider, depth: 1, maxDepth: 1 });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('嵌套深度超限');
    // 没递归 → provider.stream 未被消费（complete 也未调用）
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('子代理递归 → 黑盒回收最终结论文本', async () => {
    const subProvider = mockProvider([
      { type: 'text_delta', text: '子代理的结论' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
    });
    const res = await tool.execute!({ description: 'd', prompt: '分析这些文件' });
    expect(res.isError).toBe(false);
    expect(res.content).toBe('子代理的结论');
  });

  it('子代理产出空文本 → 回退提示（不返回空串迷惑主 LLM）', async () => {
    const subProvider = mockProvider([{ type: 'stop', reason: { unified: 'stop', raw: 'stop' } }]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
    });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('未产出文本结论');
  });
});
