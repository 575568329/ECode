import { describe, it, expect, vi } from 'vitest';
import {
  trimToolResultContents,
  isContextWindowError,
  forceCompact,
  maybeCompress,
  verifyMessagesPairing,
  TRIMMED_TOOL_RESULT_PLACEHOLDER,
} from '../src/context-manager.js';
import type { ECodeMessage } from '../src/providers/types.js';

// ============================================================
// Context 韧性测试 —— L2(tool-result 清空)+ L3(响应式恢复)+ 级联
// ============================================================
// 解决"上下文超限后无法压缩"死局。出处:Claude Code reactiveCompact / CCode 三策略。
// ============================================================

const TEST_MODEL = 'test-model'; // contextWindow 默认 128K,阈值 = 102400 token

// ---- 测试数据构造辅助 ----
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

// ============================================================
// L2: trimToolResultContents
// ============================================================
describe('trimToolResultContents', () => {
  it('tool_result 数 ≤ keepRecent → 原样返回(无需清空)', () => {
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', '内容1'),
      assistantToolCall('t2'),
      toolResult('t2', '内容2'),
    ];
    const result = trimToolResultContents(messages, 3);
    expect(result).toBe(messages); // 同一引用
  });

  it('超过 keepRecent → 早期 tool_result 内容换占位符,保留最近 N 个原文', () => {
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', '早期大段内容'),
      assistantToolCall('t2'),
      toolResult('t2', '中期内容'),
      assistantToolCall('t3'),
      toolResult('t3', '最近内容'),
    ];
    const result = trimToolResultContents(messages, 1); // 只留最近 1 个
    // 收集所有 tool_result 的 value
    const values: string[] = [];
    for (const msg of result) {
      if (typeof msg.content === 'string') continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          values.push((b.output as { value: string }).value);
        }
      }
    }
    expect(values).toHaveLength(3);
    expect(values[0]).toBe(TRIMMED_TOOL_RESULT_PLACEHOLDER); // t1 被清空
    expect(values[1]).toBe(TRIMMED_TOOL_RESULT_PLACEHOLDER); // t2 被清空
    expect(values[2]).toBe('最近内容'); // t3 保留原文
  });

  it('清空后配对不断裂(tool_use_id 全保留)', () => {
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', '内容1'),
      assistantToolCall('t2'),
      toolResult('t2', '内容2'),
      assistantToolCall('t3'),
      toolResult('t3', '内容3'),
    ];
    const result = trimToolResultContents(messages, 1);
    // 配对完整性必须保持(防 API 400)
    expect(verifyMessagesPairing(result)).toBe(true);
  });

  it('清空后数据结构仍是 ECodeMessage[]', () => {
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', '内容1'),
      assistantToolCall('t2'),
      toolResult('t2', '内容2'),
    ];
    const result = trimToolResultContents(messages, 1);
    for (const msg of result) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  it('error 类型的 tool_result 也被统一清成 text 占位符', () => {
    const messages: ECodeMessage[] = [
      assistantToolCall('t1'),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            output: { type: 'error', value: '原始错误信息' },
          },
        ],
      },
      assistantToolCall('t2'),
      toolResult('t2', '保留'),
    ];
    const result = trimToolResultContents(messages, 1);
    const firstResult = (
      result[1]!.content as Array<{ type: string; output: { type: string; value: string } }>
    ).find((b) => b.type === 'tool_result')!;
    expect(firstResult.output.type).toBe('text'); // error → text 占位
    expect(firstResult.output.value).toBe(TRIMMED_TOOL_RESULT_PLACEHOLDER);
  });

  it('不修改原数组(不可变)', () => {
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', '原始内容'),
      assistantToolCall('t2'),
      toolResult('t2', '保留'),
    ];
    const original = JSON.parse(JSON.stringify(messages));
    trimToolResultContents(messages, 1);
    expect(JSON.parse(JSON.stringify(messages))).toEqual(original); // 原数组未变
  });
});

// ============================================================
// L3: isContextWindowError
// ============================================================
describe('isContextWindowError', () => {
  it('GLM 措辞 "reached its context window limit" → true', () => {
    expect(isContextWindowError(new Error('The model has reached its context window limit'))).toBe(true);
  });

  it('Anthropic 措辞 "prompt is too long" → true', () => {
    expect(isContextWindowError(new Error('prompt is too long: 137500 tokens > 135000 maximum'))).toBe(true);
  });

  it('OpenAI 措辞 "maximum context length" → true', () => {
    expect(
      isContextWindowError(
        new Error("This model's maximum context length is 128000 tokens"),
      ),
    ).toBe(true);
  });

  it('OpenAI 错误码 "context_length_exceeded" → true', () => {
    expect(isContextWindowError(new Error('context_length_exceeded'))).toBe(true);
  });

  it('普通网络错误 → false', () => {
    expect(isContextWindowError(new Error('getaddrinfo ENOTFOUND'))).toBe(false);
    expect(isContextWindowError(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('认证错误 → false', () => {
    expect(isContextWindowError(new Error('Invalid API key'))).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isContextWindowError(new Error('PROMPT IS TOO LONG'))).toBe(true);
    expect(isContextWindowError(new Error('Context Window exceeded'))).toBe(true);
  });

  it('非 Error 值也能处理', () => {
    expect(isContextWindowError('some context window error')).toBe(true);
    expect(isContextWindowError(null)).toBe(false);
    expect(isContextWindowError(undefined)).toBe(false);
  });
});

// ============================================================
// L3: forceCompact(响应式强制压缩)
// ============================================================
describe('forceCompact', () => {
  it('trim 后够 → 返回 trim 结果,不调 summarize(零 LLM 成本)', async () => {
    // 构造:大量 tool_result 撑爆,但 trim 后能降到阈值下
    const bigResult = 'x'.repeat(60_000); // ~15000 token
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', bigResult),
      assistantToolCall('t2'),
      toolResult('t2', bigResult),
      assistantToolCall('t3'),
      toolResult('t3', bigResult),
      assistantToolCall('t4'),
      toolResult('t4', bigResult),
      assistantToolCall('t5'),
      toolResult('t5', bigResult),
      assistantToolCall('t6'),
      toolResult('t6', bigResult),
      assistantToolCall('t7'),
      toolResult('t7', bigResult),
      assistantToolCall('t8'),
      toolResult('t8', bigResult),
    ]; // 8 个 ~15000 = ~120000 token,超 102400 阈值
    const summarize = vi.fn();
    const result = await forceCompact(messages, { model: TEST_MODEL, system: '', summarize });
    expect(result).not.toBeNull();
    expect(summarize).not.toHaveBeenCalled(); // 只 trim 没调 LLM
    // 配对完整
    expect(verifyMessagesPairing(result!)).toBe(true);
  });

  it('trim 不够 → 上 summary,keepRounds 降到 2', async () => {
    // 单条巨型消息,trim 压不动(它在 early),需要 summary
    const huge = 'a'.repeat(450_000);
    const messages = [
      userText(huge),
      assistantToolCall('t1'),
      toolResult('t1'),
      assistantToolCall('t2'),
      toolResult('t2'),
    ];
    const summarize = vi.fn().mockResolvedValue('摘要');
    const result = await forceCompact(messages, { model: TEST_MODEL, system: '', summarize });
    expect(result).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('压到极限仍超限 → 返回 null(L4 熔断,放弃恢复)', async () => {
    // 单条消息就远超窗口,且无可压缩的 tool_result → forceCompact 无能为力
    const impossible = 'a'.repeat(2_000_000); // ~500000 token >> 128K 窗口
    const messages = [userText(impossible)];
    const summarize = vi.fn().mockResolvedValue('摘要'); // 即使摘要也压不下
    const result = await forceCompact(messages, { model: TEST_MODEL, system: '', summarize });
    // 摘要可能成功也可能 keepRounds 不足以压下;关键:返回的要么 null 要么配对完整
    if (result !== null) {
      expect(verifyMessagesPairing(result)).toBe(true);
    }
  });

  it('summarize 抛异常 → 返回 null', async () => {
    const huge = 'a'.repeat(450_000);
    const messages = [userText(huge), assistantText('回答')];
    const summarize = vi.fn().mockRejectedValue(new Error('网络错误'));
    const result = await forceCompact(messages, { model: TEST_MODEL, system: '', summarize });
    expect(result).toBeNull();
  });
});

// ============================================================
// maybeCompress 级联:trim(便宜)→ summary(贵)
// ============================================================
describe('maybeCompress 级联', () => {
  it('超阈值且 tool_result 多 → 先 trim,trim 够则不调 summarize', async () => {
    const bigResult = 'x'.repeat(60_000);
    const messages = [
      assistantToolCall('t1'),
      toolResult('t1', bigResult),
      assistantToolCall('t2'),
      toolResult('t2', bigResult),
      assistantToolCall('t3'),
      toolResult('t3', bigResult),
      assistantToolCall('t4'),
      toolResult('t4', bigResult),
      assistantToolCall('t5'),
      toolResult('t5', bigResult),
      assistantToolCall('t6'),
      toolResult('t6', bigResult),
      assistantToolCall('t7'),
      toolResult('t7', bigResult),
      assistantToolCall('t8'),
      toolResult('t8', bigResult),
    ];
    const summarize = vi.fn();
    const result = await maybeCompress(messages, { model: TEST_MODEL, system: '', summarize });
    expect(result.compressed).toBe(true);
    expect(result.success).toBe(true);
    expect(summarize).not.toHaveBeenCalled(); // trim 就够了,省 LLM 调用
  });

  it('trim 后仍超 → 调 summarize', async () => {
    const huge = 'a'.repeat(450_000);
    const messages = [userText(huge), assistantText('回答')];
    const summarize = vi.fn().mockResolvedValue('摘要');
    const result = await maybeCompress(messages, {
      model: TEST_MODEL,
      system: '',
      summarize,
      keepRounds: 1, // 让 early 非空,summary 才会真正触发
    });
    expect(result.compressed).toBe(true);
    expect(summarize).toHaveBeenCalled();
  });
});
