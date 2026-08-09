// 阶段3 MCP：adapter 测试。
// 重点测 Tool/Prompt 适配：命名空间、dangerous、inputSchema 透传、CallToolResult→ECode、prompt 位置参数→map。
import { describe, it, expect, vi } from 'vitest';
import { adaptMcpTool, adaptMcpPrompt } from '../src/mcp/adapter.js';

// ---- MCP 类型 mock（对齐 SDK v1.30.0 真实形状，不 import SDK 类型）----

type McpToolShape = {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
};

type McpPromptShape = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

type CallToolResultShape = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

const tool = (name: string, desc?: string, schema?: Record<string, unknown>): McpToolShape => ({
  name,
  description: desc,
  inputSchema: schema ?? { type: 'object', properties: {}, required: [] },
});

const prompt = (name: string, desc?: string, args?: McpPromptShape['arguments']): McpPromptShape => ({
  name,
  description: desc,
  arguments: args,
});

const result = (content: Array<{ type: string; text?: string }>, isError = false): CallToolResultShape =>
  ({ content, isError });

describe('adaptMcpTool（MCP tool → ECode ToolDefinition）', () => {
  it('命名空间 mcp__<server>__<tool>', () => {
    const def = adaptMcpTool('github', tool('search_repos'), vi.fn());
    expect(def.name).toBe('mcp__github__search_repos');
  });

  it('description 透传', () => {
    const def = adaptMcpTool('gh', tool('search', '搜索仓库'), vi.fn());
    expect(def.description).toBe('搜索仓库');
  });

  it('description 缺失 → 空串', () => {
    const def = adaptMcpTool('gh', tool('search'), vi.fn());
    expect(def.description).toBe('');
  });

  it('dangerous = true（不可信代码统一审批）', () => {
    expect(adaptMcpTool('gh', tool('x'), vi.fn()).dangerous).toBe(true);
  });

  it('inputSchema 透传（JSON Schema → parameters）', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    const def = adaptMcpTool('gh', tool('x', 'd', schema), vi.fn());
    expect(def.parameters).toEqual(schema);
  });

  it('execute 调 callTool 并转换结果（text content → content, isError 透传）', async () => {
    const callTool = vi.fn().mockResolvedValue(
      result([{ type: 'text', text: '找到 3 个仓库' }, { type: 'text', text: '第1: repo-a' }]),
    );
    const def = adaptMcpTool('gh', tool('search', '搜索'), callTool);
    const r = await def.execute!({ query: 'test' });
    expect(r.content).toBe('找到 3 个仓库\n第1: repo-a');
    expect(r.isError).toBe(false);
    expect(callTool).toHaveBeenCalledWith('search', { query: 'test' });
  });

  it('execute: isError=true 透传', async () => {
    const callTool = vi.fn().mockResolvedValue(result([{ type: 'text', text: '权限不足' }], true));
    const def = adaptMcpTool('gh', tool('x'), callTool);
    expect((await def.execute!({})).isError).toBe(true);
  });

  it('execute: 空 content → 空字符串', async () => {
    const callTool = vi.fn().mockResolvedValue(result([]));
    const def = adaptMcpTool('gh', tool('x'), callTool);
    expect((await def.execute!({})).content).toBe('');
  });
});

describe('adaptMcpPrompt（MCP prompt → SlashCommandDef）', () => {
  it('命名空间 + source=mcp', () => {
    const def = adaptMcpPrompt('gh', prompt('search', '搜索'), vi.fn(), vi.fn());
    expect(def.name).toBe('mcp__gh__search');
    expect(def.source).toBe('mcp');
  });

  it('argNames 从 prompt.arguments 提取', () => {
    const def = adaptMcpPrompt('gh', prompt('search', '搜索', [
      { name: 'query', description: '关键词' },
      { name: 'lang', description: '语言' },
    ]), vi.fn(), vi.fn());
    expect(def.argNames).toEqual(['query', 'lang']);
  });

  it('无 arguments → argNames 空', () => {
    const def = adaptMcpPrompt('gh', prompt('x', 'd'), vi.fn(), vi.fn());
    expect(def.argNames).toEqual([]);
  });

  it('execute: 位置参数 → argMap + getPrompt + injectAsUserMessage', async () => {
    const getPrompt = vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: '搜索结果...' }] });
    const inject = vi.fn();
    const def = adaptMcpPrompt('gh', prompt('search', '搜索', [
      { name: 'query' },
      { name: 'lang' },
    ]), getPrompt, inject);
    await def.execute(['hello', 'zh']);
    expect(getPrompt).toHaveBeenCalledWith('search', { query: 'hello', lang: 'zh' });
    expect(inject).toHaveBeenCalledWith([{ role: 'user', content: '搜索结果...' }]);
  });

  it('execute: 缺参 → 空串', async () => {
    const getPrompt = vi.fn().mockResolvedValue({ messages: [] });
    const inject = vi.fn();
    const def = adaptMcpPrompt('gh', prompt('x', 'd', [{ name: 'a' }]), getPrompt, inject);
    await def.execute([]);
    expect(getPrompt).toHaveBeenCalledWith('x', { a: '' });
  });
});
