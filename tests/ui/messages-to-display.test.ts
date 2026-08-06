// messagesToDisplayMessages 单测：历史会话 ECodeMessage[] → DisplayMessage[]（/resume 载入渲染用）。
// 纯函数，无 React/agent 依赖，覆盖详设 §6.1 全部用例。
import { describe, it, expect } from 'vitest';
import { messagesToDisplayMessages } from '../../src/ui/messages-to-display.js';
import type { ECodeMessage } from '../../src/providers/types.js';

describe('messagesToDisplayMessages', () => {
  it('纯文本对话 → user + assistant 两条', () => {
    const messages: ECodeMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好啊' },
    ];
    const result = messagesToDisplayMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'user', text: '你好' });
    expect(result[1]).toMatchObject({ kind: 'assistant', text: '你好啊' });
  });

  it('工具调用配对 → 1 条 tool 消息，name/input/content 齐全', () => {
    const messages: ECodeMessage[] = [
      { role: 'user', content: '读 package.json' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来读' },
          { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'package.json' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: '{ "name": "ecode" }' } }],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    const tool = result.find((m) => m.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      kind: 'tool',
      name: 'read_file',
      content: '{ "name": "ecode" }',
      isError: false,
      input: { path: 'package.json' },
    });
  });

  it('多 text block 合并为一条 assistant 消息', () => {
    const messages: ECodeMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    const assistants = result.filter((m) => m.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ kind: 'assistant', text: '第一段第二段' });
  });

  it('孤儿 tool_call（无配对 result）→ 跳过，不产 tool 消息', () => {
    const messages: ECodeMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '开始' },
          { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a' } },
        ],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    expect(result.some((m) => m.kind === 'tool')).toBe(false);
    // assistant 文本仍在
    expect(result.some((m) => m.kind === 'assistant' && m.text === '开始')).toBe(true);
  });

  it('error 结果 → tool 消息 isError=true', () => {
    const messages: ECodeMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'bad' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'error', value: '命令失败' } }],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    const tool = result.find((m) => m.kind === 'tool');
    expect(tool).toMatchObject({ kind: 'tool', isError: true, content: '命令失败' });
  });

  it('json 结果 → content 为 JSON 字符串', () => {
    const messages: ECodeMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'list_files', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', output: { type: 'json', value: { files: ['a', 'b'] } } }],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    const tool = result.find((m) => m.kind === 'tool');
    expect(tool).toMatchObject({ kind: 'tool', content: JSON.stringify({ files: ['a', 'b'] }) });
  });

  it('model 参数补到 assistant 消息（无 model 参数则不补）', () => {
    const messages: ECodeMessage[] = [{ role: 'assistant', content: '回复' }];
    expect(messagesToDisplayMessages(messages, 'glm-5.2')[0]).toMatchObject({
      kind: 'assistant',
      model: 'glm-5.2',
    });
    // 不传 model：assistant 消息无 model 字段（undefined）
    const noModel = messagesToDisplayMessages(messages)[0];
    expect(noModel).toMatchObject({ kind: 'assistant' });
    expect((noModel as { model?: string }).model).toBeUndefined();
  });

  it('每条 DisplayMessage 有稳定唯一 id', () => {
    const messages: ECodeMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const result = messagesToDisplayMessages(messages);
    const ids = result.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(typeof id).toBe('string'));
  });

  it('user content 为 string 与 blocks 混合都能处理', () => {
    // 首句 user 是 string；工具结果 user 是 blocks（含 tool_result）
    const messages: ECodeMessage[] = [
      { role: 'user', content: '首句' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '附带说明' },
          { type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: 'a\nb' } },
        ],
      },
    ];
    const result = messagesToDisplayMessages(messages);
    // 首句 user（text）+ 附带说明 user（text block）+ tool（result 配对）
    const users = result.filter((m) => m.kind === 'user');
    expect(users.some((u) => u.text === '首句')).toBe(true);
    expect(users.some((u) => u.text === '附带说明')).toBe(true);
    expect(result.some((m) => m.kind === 'tool')).toBe(true);
  });
});
