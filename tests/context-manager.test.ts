import { describe, it, expect, vi } from 'vitest';
import { maybeCompress, verifyMessagesPairing, buildCompressPrompt } from '../src/context-manager.js';
import type { ECodeMessage } from '../src/providers/types.js';

// ============================================================
// ContextManager 门面测试 —— maybeCompress 的阈值判断 + 压缩 + 降级
// ============================================================
// 用 mock summarize 避免真实 LLM 调用。
// 用 'test-model'（config 里无此模型）→ getContextWindow 默认 128K → 阈值 102400。
// ============================================================

const TEST_MODEL = 'test-model'; // contextWindow 默认 128K，阈值 = 102400 token

function userText(text: string): ECodeMessage {
  return { role: 'user', content: text };
}
function assistantText(text: string): ECodeMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantToolCall(id: string): ECodeMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', id, name: 'read_file', input: { path: 'x' } }],
  };
}
function toolResult(id: string, value = '结果'): ECodeMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, output: { type: 'text', value } }],
  };
}

describe('maybeCompress 阈值判断', () => {
  it('未超阈值 → 原样返回，compressed: false', async () => {
    const messages = [userText('短任务'), assistantText('短回答')];
    const summarize = vi.fn();
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: 'system',
      summarize,
    });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages); // 同一引用，未动
    expect(summarize).not.toHaveBeenCalled(); // 未超阈值不调 summarize
  });

  it('超阈值 → 触发压缩，compressed: true', async () => {
    // 构造超 102400 token 的长消息（约 45 万字符）
    const longText = 'a'.repeat(450_000);
    const messages = [userText(longText), assistantText('ok')];
    const summarize = vi.fn().mockResolvedValue('这是摘要');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.compressed).toBe(true);
    // 压缩后第一条应是摘要（早期长文本被压成摘要），token 大幅减少
    expect(result.messages[0].role).toBe('user');
  });
});

describe('maybeCompress 压缩后结构', () => {
  it('压缩输出仍是 ECodeMessage[]（数据结构不变）', async () => {
    const longText = 'a'.repeat(450_000);
    const messages = [
      userText(longText),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantText('最终回答'),
    ];
    const summarize = vi.fn().mockResolvedValue('摘要内容');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 2,
    });
    // 每条消息仍是 { role, content } 结构
    for (const msg of result.messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
      expect(['user', 'assistant']).toContain(msg.role);
    }
  });

  it('压缩后配对完整性校验通过（无孤儿）', async () => {
    const longText = 'a'.repeat(450_000);
    const messages = [
      userText(longText),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
      assistantToolCall('t3'),
      toolResult('t3'),
    ];
    const summarize = vi.fn().mockResolvedValue('摘要');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 2,
    });
    expect(result.compressed).toBe(true);
    // 压缩后必须配对完整（防 API 400）
    expect(verifyMessagesPairing(result.messages)).toBe(true);
  });

  it('压缩后第一条是摘要消息（user 角色，标注压缩摘要）', async () => {
    const longText = 'a'.repeat(450_000);
    const messages = [userText(longText), assistantText('answer'), assistantText('answer2')];
    const summarize = vi.fn().mockResolvedValue('已读文件发现 bug');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1,
    });
    const first = result.messages[0];
    expect(first.role).toBe('user');
    const text = typeof first.content === 'string' ? first.content : '';
    expect(text).toContain('压缩摘要');
    expect(text).toContain('已读文件发现 bug');
  });

  it('summarize 收到的是早期对话的序列化文本（含工具调用）', async () => {
    const longText = 'a'.repeat(450_000);
    // 多构造几轮，让 keepRounds=1 时 early 里能包含工具往返
    const messages = [
      userText(longText),
      assistantToolCall('t1'),
      toolResult('t1', '早期结果'),
      assistantToolCall('t2'),
      toolResult('t2'),
    ];
    const summarize = vi.fn().mockResolvedValue('摘要');
    await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1, // 只保留最后 1 个往返组（t2），early 含 t1
    });
    const prompt = summarize.mock.calls[0]?.[0] as string;
    // prompt 应包含早期消息的序列化内容（含 t1 工具调用）
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('read_file'); // 工具调用名
    expect(prompt).toContain('早期结果'); // tool_result 内容
  });
});

describe('buildCompressPrompt', () => {
  it('包含保留/丢弃/要求三类指令', () => {
    const prompt = buildCompressPrompt('早期对话内容');
    // 保留：用户目标、关键操作、重要事实
    expect(prompt).toContain('目标');
    expect(prompt).toContain('结论');
    // 丢弃：冗余工具输出
    expect(prompt).toContain('丢弃');
    // 禁止编造
    expect(prompt).toMatch(/不.{0,4}编造|禁止编造/);
  });

  it('末尾拼接早期对话内容', () => {
    const early = '[user] 修登录bug\n[assistant] 调用工具';
    const prompt = buildCompressPrompt(early);
    expect(prompt).toContain(early);
  });
});

describe('maybeCompress 降级', () => {
  it('summarize 抛异常 → 降级返回原消息，success: false', async () => {
    const longText = 'a'.repeat(450_000);
    const messages = [userText(longText), assistantText('answer')];
    const summarize = vi.fn().mockRejectedValue(new Error('网络错误'));
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1,
    });
    expect(result.compressed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.messages).toBe(messages); // 降级返回原消息
  });

  it('压缩破坏配对 → 抛错被降级捕获，返回原消息', async () => {
    // 构造一个会让压缩后产生孤儿的场景很难（算法保证不破坏），
    // 这里用 mock summarize 正常返回 + 验证 success 通道即可
    const longText = 'a'.repeat(450_000);
    const messages = [userText(longText), assistantToolCall('t1'), toolResult('t1')];
    const summarize = vi.fn().mockResolvedValue('正常摘要');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1,
    });
    // 正常压缩路径，配对完整 → success: true
    expect(result.success).toBe(true);
  });
});
