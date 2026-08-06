import { describe, it, expect, vi } from 'vitest';
import { runAgentStream } from '../src/agent.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ResumeContext } from '../src/agent.js';
import type { ECodeMessage, ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';
import { isOverThreshold } from '../src/context-manager.js';
import { getContextWindow } from '../src/providers/config.js';

/** 造一个返回固定 chunk 流的 mock provider（complete 给桩，summarize 压缩时用）。 */
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

describe('runAgentStream', () => {
  it('纯文本回复 → start / text_delta / completed(done)', async () => {
    const provider = mockProvider([
      { type: 'text_delta', text: '你好' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    expect(events[0].type).toBe('start');
    expect(events.some((e) => e.type === 'text_delta' && e.text === '你好')).toBe(true);
    const done = events.find((e) => e.type === 'completed');
    expect(done?.type === 'completed' && done.reason).toBe('done');
  });

  it('工具调用 → tool_call_start / tool_result 事件序列正确', async () => {
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"package.json"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    // 简化：只测第一轮事件，不构造完整多轮（多轮需 provider 按 messages 返回不同流）
    const events = await collect(runAgentStream('读 package.json', { provider }));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_result');
    const tr = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(tr.id).toBe('t1');
    expect(tr.name).toBe('read_file');
  });

  it('tool_call_start / tool_result 事件携带 input（§9.5 透传，供历史区摘要）', async () => {
    // 回归 §9.5：旧实现两事件都不带 input → 历史区 summarizeArg 拿不到参数，
    // bash 命令/文件路径等摘要从不显示。consumeStream 解析 inputDelta 进 tc.input，
    // 两事件发射时须透传。
    const provider = mockProvider([
      { type: 'tool_call_start', id: 't1', name: 'bash' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"command":"echo hi"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('跑测试', { provider }));
    const start = events.find((e) => e.type === 'tool_call_start') as Extract<
      AgentEvent,
      { type: 'tool_call_start' }
    >;
    const result = events.find((e) => e.type === 'tool_result') as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(start.input).toEqual({ command: 'echo hi' });
    expect(result.input).toEqual({ command: 'echo hi' });
  });

  it('text + tool_call 同时出现 → text_delta 在 tool_call_start 之前 yield（事件流完整性）', async () => {
    // 回归：LLM 常见模式"让我读取 package.json" + tool_call，text 必须作为事件流出
    const provider = mockProvider([
      { type: 'text_delta', text: '让我读取 package.json' },
      { type: 'tool_call_start', id: 't1', name: 'read_file' },
      { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"package.json"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'stop', reason: { unified: 'tool-use', raw: 'tool_calls' } },
    ]);
    const events = await collect(runAgentStream('读 package.json', { provider }));
    const textIdx = events.findIndex((e) => e.type === 'text_delta');
    const toolStartIdx = events.findIndex((e) => e.type === 'tool_call_start');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeGreaterThan(textIdx); // text 在 tool_call_start 之前
    const td = events[textIdx] as Extract<AgentEvent, { type: 'text_delta' }>;
    expect(td.text).toBe('让我读取 package.json');
  });

  it('LLM 流末带 usage → yield usage 事件（input/output tokens）', async () => {
    const provider = mockProvider([
      { type: 'text_delta', text: 'done' },
      { type: 'usage', inputTokens: 120, outputTokens: 30 },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect(usage?.type === 'usage' && usage.inputTokens).toBe(120);
    expect(usage?.type === 'usage' && usage.outputTokens).toBe(30);
  });

  it('多轮对话 → 每轮各 yield 一个 usage 事件（可累计）', async () => {
    // 第一轮：tool-use；第二轮：纯文本结束。
    // 用一个按 messages 长度返回不同流的自定义 provider
    let call = 0;
    const provider: ModelProvider = {
      name: 'mock',
      protocol: 'openai',
      baseURL: 'http://mock',
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: '压缩摘要' }],
        stopReason: { unified: 'stop' },
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      stream: async function* (req: ChatRequest): AsyncIterable<ECodeStreamPart> {
        call++;
        if (call === 1) {
          yield { type: 'tool_call_start', id: 't1', name: 'read_file' };
          yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"a"}' };
          yield { type: 'tool_call_end', id: 't1' };
          yield { type: 'usage', inputTokens: 100, outputTokens: 10 };
          yield { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } };
        } else {
          yield { type: 'text_delta', text: '好了' };
          yield { type: 'usage', inputTokens: 200, outputTokens: 20 };
          yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
        }
      },
    };
    const events = await collect(runAgentStream('读 a', { provider }));
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(2);
  });

  it('多个 text_delta chunk → 逐 chunk yield 为独立事件（R4 真流式）', async () => {
    // 回归 M3.5 R4：旧实现 consumeStream 把整轮 text 累加后只 yield 一次，
    // 导致 UI 动态区每轮只收到一坨完整文本，并不流式。改为逐 chunk yield 后，
    // 3 个 chunk 应产出 3 个独立 text_delta 事件，顺序与输入一致。
    const provider = mockProvider([
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
      { type: 'text_delta', text: '！' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    const textDeltas = events.filter(
      (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    );
    expect(textDeltas).toHaveLength(3);
    expect(textDeltas.map((e) => e.text)).toEqual(['你', '好', '！']);
  });

  it('多 chunk 文本仍正确累积进 message 历史（assistant block.text 完整）', async () => {
    // R4 副作用校验：逐 chunk yield 不能破坏内部 message 累积——
    // 本轮 assistant 回复 push 进 messages 时 text 必须是完整拼接。
    // 通过第二轮 provider 收到的 messages 间接断言（assistant 上轮文本应为 '你好！'）。
    let call = 0;
    const seenMessages: unknown[] = [];
    const provider: ModelProvider = {
      name: 'mock',
      protocol: 'openai',
      baseURL: 'http://mock',
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: '压缩摘要' }],
        stopReason: { unified: 'stop' },
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
      stream: async function* (req: ChatRequest): AsyncIterable<ECodeStreamPart> {
        call++;
        seenMessages.push(req.messages);
        if (call === 1) {
          // 第一轮：3 chunk 文本 + tool_call（不终止，进第二轮）
          yield { type: 'text_delta', text: '你' };
          yield { type: 'text_delta', text: '好' };
          yield { type: 'text_delta', text: '！' };
          yield { type: 'tool_call_start', id: 't1', name: 'read_file' };
          yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"path":"a"}' };
          yield { type: 'tool_call_end', id: 't1' };
          yield { type: 'stop', reason: { unified: 'tool-use', raw: 'tc' } };
        } else {
          yield { type: 'text_delta', text: '完成' };
          yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
        }
      },
    };
    const events = await collect(runAgentStream('读 a', { provider }));
    expect(events.some((e) => e.type === 'completed')).toBe(true);
    // 第二轮收到的 messages 里，上轮 assistant 文本块应为完整 '你好！'
    const round2 = seenMessages[1] as Array<{ role: string; content: unknown }>;
    const assistantBlocks = round2.find((m) => m.role === 'assistant')?.content as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = assistantBlocks.find((b) => b.type === 'text');
    expect(textBlock?.text).toBe('你好！');
  });

  it('纯文本 done → completed 带 sessionId/messages/task/createdAt，messages 含最终 assistant 回复', async () => {
    // 回归：done 路径必须在 push assistant 之后才 completed。历史 bug：push 写在 if(done) 之后，
    // 导致纯文本最终回答进不了 messages → REPL 续接 / --continue 时 LLM 看不到自己上一轮的回答。
    const provider = mockProvider([
      { type: 'text_delta', text: '你好啊' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('打招呼', { provider }));
    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'completed' }> => e.type === 'completed',
    );
    expect(done).toBeDefined();
    expect(done!.reason).toBe('done');
    // 续接真相源字段
    expect(done!.sessionId).toEqual(expect.any(String));
    expect(done!.sessionId.length).toBeGreaterThan(0);
    expect(done!.task).toBe('打招呼');
    expect(done!.createdAt).toEqual(expect.any(String));
    // 关键：messages 末尾是本轮 assistant 文本回答（push 提前修复）
    const last = done!.messages[done!.messages.length - 1];
    expect(last.role).toBe('assistant');
    const textBlock = (last.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text',
    );
    expect(textBlock?.text).toBe('你好啊');
  });

  it('resumed 续接 → 复用原 sessionId/task/createdAt，messages = 历史 + 新 user + 新 assistant', async () => {
    // REPL 多轮续接核心：useAgentStream 把上一轮 completed 带回的 {id,messages,...} 经 resumed 传回，
    // agent 必须复用同一会话（不新建 id/文件）、带上轮历史、且不覆盖首句 task/createdAt。
    const resumed: ResumeContext = {
      id: 'reuse-this-id',
      task: '原首句任务',
      createdAt: '2026-01-01T00:00:00.000Z',
      messages: [
        { role: 'user', content: '原首句任务' },
        { role: 'assistant', content: [{ type: 'text', text: '原回答' }] },
      ],
    };
    const provider = mockProvider([
      { type: 'text_delta', text: '新回答' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(runAgentStream('追问', { provider, resumed }));
    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'completed' }> => e.type === 'completed',
    );
    expect(done).toBeDefined();
    expect(done!.sessionId).toBe('reuse-this-id'); // 复用，不新建
    expect(done!.task).toBe('原首句任务'); // 不被当前 "追问" 覆盖
    expect(done!.createdAt).toBe('2026-01-01T00:00:00.000Z'); // 保持不变
    // messages 顺序：历史(2 条) + 新 user("追问") + 新 assistant("新回答")
    expect(done!.messages).toHaveLength(4);
    expect(done!.messages[2].role).toBe('user');
    expect(done!.messages[3].role).toBe('assistant');
    const lastText = (done!.messages[3].content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text',
    );
    expect(lastText?.text).toBe('新回答');
  });

  it('resumed 注入大量消息 → 首轮触发上下文压缩 → yield warning 事件', async () => {
    // 验证 agent loop 的 maybeCompress 链路真正被触发：
    //   test-model → getContextWindow 兜底 128K → 阈值 102400 token ≈ 410K 字符。
    //   注入 450K 字符（≈112K token）的 resumed messages → 超阈值 → L3 摘要压缩。
    //   agent 应 yield warning 事件，且正常流程（start / text_delta / completed）不缺。
    const bigText = 'a'.repeat(450_000); // ≈112K tokens（length/4 估算），超过 102K 阈值
    const preMessages: ECodeMessage[] = [
      { role: 'user', content: bigText },
      { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
    ];
    const provider = mockProvider([
      { type: 'text_delta', text: '压缩后继续' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const events = await collect(
      runAgentStream('短任务', {
        provider,
        model: 'test-model', // contextWindow 兜底 128K → 阈值 102K token
        system: '', // 空 system，不贡献 token
        resumed: {
          id: 'compress-test',
          task: '压缩测试',
          createdAt: '',
          messages: preMessages,
        },
      }),
    );
    // 压缩触发 → yield warning 事件（agent.ts:272）
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect((warnings[0] as { type: 'warning'; message: string }).message).toContain('压缩');
    // 正常流程事件不缺：start / text_delta / completed
    expect(events.some((e) => e.type === 'start')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('glm-5.2 真实 config 链路 → contextWindow = 1M, threshold = 800K', () => {
    // 验证不 mock config 时，真实 config 链路正确取到 glm-5.2 的 1M 上下文窗口。
    // getContextWindow → getModelConfig → loadConfig → config.json 或 DEFAULT_CONFIG。
    expect(getContextWindow('glm-5.2')).toBe(1_000_000);
    // 阈值 = 1M × 0.8 = 800,000
    const { threshold } = isOverThreshold('glm-5.2', '', []);
    expect(threshold).toBe(800_000);
  });

  // 注：原「glm-5.2 真实阈值(800K token) → 超量消息触发压缩」用例已移除——
  // 它为绕过 glm-5.2 的 1M 窗口造了 'a'.repeat(3_300_000)（330 万字符），仅 mock vi.fn
  // deep-serialize 调用快照就要数秒，且与上方两用例功能重叠：
  //   · 「真实 config 链路 → 800K」（纯函数）已覆盖 glm config 取值；
  //   · 「resumed 注入大量消息 → 触发压缩」（test-model）已覆盖 agent loop 压缩端到端。
  // 换 model 重跑同一 agent 路径不增覆盖，代价却是巨型字符串，故删。
});
