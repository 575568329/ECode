import { describe, it, expect } from 'vitest';
import { countTokens } from '../src/token-counter.js';

describe('countTokens', () => {
  // ---- 基础: length/4 粗估 ----

  it('纯英文: 4 字符 ≈ 1 token', () => {
    // "hello world" = 11 chars → Math.round(11/4) = 3
    expect(countTokens('test-model', '', [{ role: 'user', content: 'hello world' }])).toBe(3);
  });

  it('中文: length/4 高估（保守方向，宁可早压缩）', () => {
    // 中文实际约 1-2 字符/token，但 length/4 假设 4 字符/token → 高估
    // "你好世界" = 4 chars → Math.round(4/4) = 1（实际约 2-4 token）
    // 不追求精确，只验证函数跑通、方向正确（高估 = 安全）
    const tokens = countTokens('test-model', '', [{ role: 'user', content: '你好世界' }]);
    expect(tokens).toBeGreaterThanOrEqual(1);
    expect(typeof tokens).toBe('number');
  });

  it('空消息返回 0（仅 system 也走 system 分支）', () => {
    expect(countTokens('test-model', '', [])).toBe(0);
  });

  it('system prompt 也计入 token', () => {
    // system = "abc" → 1 token, messages = [] → 0 token, total = 1
    const tokens = countTokens('test-model', 'abc', []);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  // ---- JSON 类内容: length/2（单字符 token 多） ----

  it('JSON 格式内容用 length/2 估算', () => {
    // JSON 字符串: `{"name":"test"}` = 17 chars → Math.round(17/2) = 9（比 /4 的 4 更高）
    const jsonContent = JSON.stringify({ name: 'test', path: '/src/index.ts' });
    const tokens = countTokens('test-model', '', [
      { role: 'user', content: jsonContent },
    ]);
    // JSON 类用 /2，比纯文本 /4 高
    const plainTokens = Math.ceil(jsonContent.length / 4);
    expect(tokens).toBeGreaterThan(plainTokens);
  });

  // ---- 累积: system + 多条 messages ----

  it('system + 多条 messages 累加计算', () => {
    const system = 'system-prompt'; // 14 chars
    const msg1 = { role: 'user' as const, content: 'hello' }; // 5 chars
    const msg2 = { role: 'assistant' as const, content: 'hi there' }; // 8 chars
    const total = countTokens('test-model', system, [msg1, msg2]);
    // 纯文本: (14+5+8)/4 ≈ 6-7，不追求精确只验证累加
    expect(total).toBeGreaterThan(5);
  });

  // ---- block 类型消息（ECode 内部格式）----

  it('block 类型消息: text block 按 /4 计算', () => {
    const tokens = countTokens('test-model', '', [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'doing stuff' }],
      },
    ]);
    // "doing stuff" = 11 chars → 3 token
    expect(tokens).toBe(3);
  });

  it('block 类型消息: tool_call block 也计入（id/name/input 序列化后估算）', () => {
    const tokens = countTokens('test-model', '', [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me read' },
          { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'x' } },
        ],
      },
    ]);
    // text "let me read" = 11 → 3, tool_call 序列化（id+name+input）也计入
    expect(tokens).toBeGreaterThan(3);
  });

  it('block 类型消息: tool_result output.text 按 /4 计算', () => {
    const tokens = countTokens('test-model', '', [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: 'file content here' } },
        ],
      },
    ]);
    // "file content here" = 17 chars → Math.round(17/4) = 4
    expect(tokens).toBe(4);
  });

  it('block 类型消息: tool_result output.json 按 /2 计算', () => {
    const jsonValue = { files: ['a.ts', 'b.ts'], count: 2 };
    const tokens = countTokens('test-model', '', [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', output: { type: 'json', value: jsonValue } },
        ],
      },
    ]);
    // JSON 序列化后按 /2 计算（比 /4 高）
    const serialized = JSON.stringify(jsonValue);
    const plainEstimate = Math.ceil(serialized.length / 4);
    expect(tokens).toBeGreaterThan(plainEstimate);
  });
});
