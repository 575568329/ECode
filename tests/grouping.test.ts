import { describe, it, expect } from 'vitest';
import {
  groupToolRounds,
  splitForCompression,
  type ToolRound,
} from '../src/context-manager.js';
import type { ECodeMessage } from '../src/providers/types.js';

// ============================================================
// 成对分组 + 切分算法测试 —— 压缩"最小单元是工具往返"的核心
// ============================================================
// 用户的两个核心约束：
// 1. "一个提问和回答是一个最小单元" → 压缩边界落在完整往返之间
// 2. "数据结构不变" → 压缩输出仍是 ECodeMessage[]
// ============================================================

// ---- 测试数据构造辅助 ----

function userText(text: string): ECodeMessage {
  return { role: 'user', content: text };
}
function assistantText(text: string): ECodeMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantToolCall(id: string, name = 'read_file'): ECodeMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', id, name, input: { path: 'x' } }],
  };
}
function assistantTextAndToolCall(text: string, id: string): ECodeMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_call', id, name: 'read_file', input: { path: 'x' } },
    ],
  };
}
function toolResult(id: string, value = '结果'): ECodeMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, output: { type: 'text', value } }],
  };
}

describe('groupToolRounds', () => {
  it('空消息 → 空分组', () => {
    expect(groupToolRounds([])).toEqual([]);
  });

  it('纯对话（无工具）→ 每条消息各自一组', () => {
    const messages = [userText('问'), assistantText('答')];
    const rounds = groupToolRounds(messages);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].messages).toEqual([messages[0]]);
    expect(rounds[1].messages).toEqual([messages[1]]);
  });

  it('单个工具往返（call + result）→ 一组', () => {
    const messages = [
      userText('读文件'),
      assistantToolCall('t1'),
      toolResult('t1'),
    ];
    const rounds = groupToolRounds(messages);
    expect(rounds).toHaveLength(2); // user 任务一组 + 工具往返一组
    // 第二组应包含 tool_call 和 tool_result（完整往返）
    expect(rounds[1].messages).toHaveLength(2);
    expect(rounds[1].hasToolPair).toBe(true);
  });

  it('assistant 的 text 和 tool_call 同一条消息 → 同一组', () => {
    const messages = [
      userText('读文件'),
      assistantTextAndToolCall('我看看', 't1'),
      toolResult('t1'),
    ];
    const rounds = groupToolRounds(messages);
    // user 一组, [assistant(text+call), user(result)] 一组
    expect(rounds).toHaveLength(2);
    expect(rounds[1].messages).toHaveLength(2);
    expect(rounds[1].hasToolPair).toBe(true);
  });

  it('多个连续工具往返 → 各自独立分组（绝不拆散配对）', () => {
    const messages = [
      userText('读两个文件'),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
    ];
    const rounds = groupToolRounds(messages);
    expect(rounds).toHaveLength(3); // user + 往返1 + 往返2
    expect(rounds[1].messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(rounds[2].messages.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('一个 assistant 消息含多个 tool_call → 全部归到同一往返组', () => {
    // 并行工具调用：一条 assistant 消息含 t1 + t2 两个 call
    const messages = [
      userText('并行读'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 't1', name: 'read_file', input: {} },
          { type: 'tool_call', id: 't2', name: 'read_file', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', output: { type: 'text', value: 'r1' } },
          { type: 'tool_result', tool_use_id: 't2', output: { type: 'text', value: 'r2' } },
        ],
      },
    ];
    const rounds = groupToolRounds(messages);
    expect(rounds).toHaveLength(2); // user + 一个并行往返组
    expect(rounds[1].messages).toHaveLength(2);
    expect(rounds[1].hasToolPair).toBe(true);
  });
});

describe('splitForCompression', () => {
  it('未超过 keepRounds → 全部保留，无待压缩', () => {
    const messages = [userText('问'), assistantText('答')];
    const { early, recent } = splitForCompression(messages, { keepRounds: 5 });
    expect(early).toHaveLength(0);
    expect(recent).toEqual(messages);
  });

  it('超过 keepRounds → 早期消息进 early，最近 N 组进 recent', () => {
    const messages = [
      userText('任务'),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
      assistantToolCall('t3'),
      toolResult('t3'),
    ];
    // keepRounds=2 → 最近 2 个往返组保留，早期压缩
    const { early, recent } = splitForCompression(messages, { keepRounds: 2 });
    // early: [任务, 往返1]
    // recent: [往返2, 往返3]
    expect(early.length).toBeGreaterThan(0);
    expect(recent.length).toBeGreaterThan(0);
    // recent 必须以完整的往返组开头（不能劈开 tool_call/tool_result）
    const firstRecentMsg = recent[0];
    expect(firstRecentMsg.role).toBe('assistant'); // 往返组从 assistant 的 call 开始
  });

  it('切分边界不劈开工具往返（关键约束）', () => {
    const messages = [
      userText('任务'),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
    ];
    const { early, recent } = splitForCompression(messages, { keepRounds: 1 });
    // 验证 recent 的第一组是完整往返（有 tool_call 必有对应 tool_result）
    const recentCalls = recent
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_call');
    const recentResults = recent
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_result');
    // recent 内部必须配对完整
    const callIds = new Set(recentCalls.map((b) => (b as { id: string }).id));
    const resultIds = new Set(recentResults.map((b) => (b as { tool_use_id: string }).tool_use_id));
    expect(callIds).toEqual(resultIds);

    // early 内部也必须配对完整
    const earlyCalls = early
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_call');
    const earlyResults = early
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'tool_result');
    const eCallIds = new Set(earlyCalls.map((b) => (b as { id: string }).id));
    const eResultIds = new Set(earlyResults.map((b) => (b as { tool_use_id: string }).tool_use_id));
    expect(eCallIds).toEqual(eResultIds);
  });

  it('切分后 early + recent 拼起来 == 原消息全集（不丢消息）', () => {
    const messages = [
      userText('任务'),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
      assistantToolCall('t3'),
      toolResult('t3'),
    ];
    const { early, recent } = splitForCompression(messages, { keepRounds: 2 });
    expect([...early, ...recent]).toEqual(messages);
  });
});
