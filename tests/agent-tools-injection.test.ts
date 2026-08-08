// 阶段 0 地基测试：runAgentStream 的 opts.tools 注入（子代理工具子集 / MCP 工具的地基）。
// 验证：① 传入 tools 生效（自定义工具被执行）② 子集外工具被拒（未知工具 isError）
//      ③ 不传 tools 默认内置（现有行为不变，零回归）
import { describe, it, expect, vi } from 'vitest';
import { runAgentStream } from '../src/agent.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';
import type { ToolDefinition } from '../src/tools/types.js';

/** 造一个返回固定 chunk 流的 mock provider（同 agent-stream.test.ts 模式）。 */
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

describe('runAgentStream opts.tools 注入（阶段 0 地基）', () => {
  it('传入 tools → agent 使用注入的工具集（自定义工具被执行）', async () => {
    const customTool: ToolDefinition = {
      name: 'custom_greet',
      description: '测试用自定义工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: 'hello from custom', isError: false }),
    };
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'custom_greet' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('测试', { provider, tools: [customTool] }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.name).toBe('custom_greet');
    expect(tr.content).toBe('hello from custom');
    expect(tr.isError).toBe(false);
  });

  it('tools 子集外的工具调用 → 找不到 def → 未知工具 isError 回喂', async () => {
    // 传空 tools，provider 返回 read_file（子集外），executeTool 在空 defs 里找不到 → 未知工具。
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('测试', { provider, tools: [] }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain('未知工具');
  });

  it('不传 tools → 默认内置 toolDefinitions（现有行为不变，零回归）', async () => {
    // read_file 是内置工具；不传 tools → 走默认 → 能找到 def（不报「未知工具」）。
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"package.json"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('读', { provider }));
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr).toBeDefined();
    expect(tr.name).toBe('read_file');
    // read_file 真实执行读 package.json，内容不会是「未知工具」（证明走了默认内置表）。
    expect(tr.content).not.toContain('未知工具');
  });
});
