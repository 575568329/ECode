// agent-loop-controller 单测（消息队列与交互重做方案 §10）。
// 纯调度逻辑：pendingQueue / busyRef 状态机 / aborted 不丢历史 / compact 互斥。
// mock runAgent 为可控 async generator（gate 挂起 + signal 响应），不依赖 React / 真实 LLM。
import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '../../src/agent-events.js';
import type { ECodeMessage } from '../../src/providers/types.js';
import type { RunAgentStreamOptions } from '../../src/agent.js';
import {
  AgentLoopController,
  type BusyState,
  type ControllerCallbacks,
} from '../../src/ui/agent-loop-controller.js';

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 构造 completed 事件（带全量 messages，模拟 agent completed 回填真相源）。 */
function completed(
  text: string,
  messages: ECodeMessage[],
  reason: 'done' | 'aborted' = 'done',
): Extract<AgentEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rounds: 1,
    toolCalls: 0,
    reason,
    sessionId: `s-${text}`,
    task: text,
    createdAt: 't',
    messages,
  };
}

/** 编排式 mock runAgent：每条 text 挂起在专属 gate，释放后按 signal 状态产出 done/aborted 序列。 */
function makeRunAgent() {
  const calls: Array<{ text: string; signal?: AbortSignal; resumedMessages?: ECodeMessage[] }> = [];
  const gates = new Map<string, { resolve: () => void }>();
  const runAgent = async function* (
    text: string,
    opts: RunAgentStreamOptions,
  ): AsyncGenerator<AgentEvent> {
    calls.push({ text, signal: opts.signal, resumedMessages: opts.resumed?.messages });
    const gate = deferred();
    gates.set(text, gate);
    await gate.promise; // 挂起，直到测试释放
    yield { type: 'start', task: text, model: 'm', provider: 'p' };
    if (opts.signal?.aborted) {
      // 中断：yield aborted completed，messages 含中断前 partial assistant（验证不丢历史）
      yield completed(
        text,
        [
          { role: 'user', content: text },
          { role: 'assistant', content: [{ type: 'text', text: '部分' }] },
        ],
        'aborted',
      );
      return;
    }
    yield { type: 'text_delta', text: `回复:${text}` };
    yield completed(text, [
      { role: 'user', content: text },
      { role: 'assistant', content: [{ type: 'text', text: `回复:${text}` }] },
    ]);
  };
  return { runAgent, calls, gates };
}

interface Harness {
  controller: AgentLoopController;
  events: AgentEvent[];
  queue: string[][];
  userTurns: string[];
  busy: BusyState[];
  messagesResets: ECodeMessage[][];
  runAgent: ReturnType<typeof makeRunAgent>;
  compactMessages: ReturnType<typeof vi.fn>;
}

/** 标准测试 harness：gate 式 runAgent + 默认压成 1 条的 compactMessages + 全回调 spy。 */
function makeHarness(): Harness {
  const runAgent = makeRunAgent();
  const compactMessages = vi.fn(async (m: ECodeMessage[]) => [m[0] ?? { role: 'user', content: '压缩后' }]);
  const events: AgentEvent[] = [];
  const queue: string[][] = [];
  const userTurns: string[] = [];
  const busy: BusyState[] = [];
  const messagesResets: ECodeMessage[][] = [];
  const callbacks: ControllerCallbacks = {
    onEvent: (e) => events.push(e),
    onQueueChange: (q) => queue.push([...q]),
    onUserTurn: (t) => userTurns.push(t),
    onBusyChange: (b) => busy.push(b),
    onMessagesReset: (m) => messagesResets.push([...m]),
  };
  const controller = new AgentLoopController({
    runAgent: runAgent.runAgent,
    compactMessages,
    getRunOpts: () => ({}),
    getCompactOpts: () => ({ model: 'm', system: '' }),
    callbacks,
  });
  return { controller, events, queue, userTurns, busy, messagesResets, runAgent, compactMessages };
}

describe('AgentLoopController', () => {
  it('单条 submit → 出队 → 跑完 → idle（状态机 idle→running→idle）', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    expect(h.controller.busy).toBe('running');
    expect(h.userTurns).toEqual(['A']);
    expect(h.queue.at(-1)).toEqual([]); // A 已出队，队列空

    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');
    expect(h.busy).toEqual(['running', 'idle']);
    expect(h.events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('忙时再 submit → 入队不丢；当前轮完成后按序出队处理', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    h.controller.submit('B'); // 忙时入队
    expect(h.queue.at(-1)).toEqual(['B']);
    expect(h.controller.busy).toBe('running');

    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    expect(h.userTurns).toEqual(['A', 'B']); // A 完成后 B 出队

    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');
  });

  it('多次 submit 全部按序处理（FIFO）', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    h.controller.submit('B');
    h.controller.submit('C');
    await nextTick();
    expect(h.userTurns).toEqual(['A']); // 仅 A 出队，B/C 排队

    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    expect(h.userTurns).toEqual(['A', 'B']);

    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    expect(h.userTurns).toEqual(['A', 'B', 'C']);

    h.runAgent.gates.get('C')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');
  });

  it('aborted 保留中断前 partial 历史（下一轮 resumed 带上）', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    h.controller.abort(); // signal.aborted = true
    h.runAgent.gates.get('A')!.resolve(); // mock 见 aborted → yield aborted completed（含 partial）
    await nextTick();
    expect(h.controller.busy).toBe('idle');

    const done = h.events.find(
      (e): e is Extract<AgentEvent, { type: 'completed' }> => e.type === 'completed',
    );
    expect(done?.reason).toBe('aborted');

    // 下一轮 resumed.messages 应含 A 的 partial（controller 回填 messagesRef，不丢历史）
    h.controller.submit('B');
    await nextTick();
    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    const bCall = h.runAgent.calls.find((c) => c.text === 'B')!;
    expect(bCall.resumedMessages).toBeDefined();
    expect(bCall.resumedMessages!.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('aborted 后若 queue 还有消息 → 继续 drain（不死锁，§3.1 死锁修复验证）', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    h.controller.submit('B'); // 排队
    h.controller.abort(); // 中断 A
    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    expect(h.userTurns).toEqual(['A', 'B']); // A aborted 完成后 B 立即出队，不死锁

    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');
  });

  it('error → 落 error 事件 + 继续 drain 下一条（不重跑同一条）', async () => {
    const events: AgentEvent[] = [];
    const userTurns: string[] = [];
    // A 抛错，B 正常完成
    const runAgent = async function* (text: string): AsyncGenerator<AgentEvent> {
      if (text === 'A') throw new Error('boom');
      yield { type: 'start', task: text, model: 'm', provider: 'p' };
      yield completed(text, [{ role: 'user', content: text }]);
    };
    const controller = new AgentLoopController({
      runAgent,
      compactMessages: vi.fn(async (m: ECodeMessage[]) => m),
      getRunOpts: () => ({}),
      getCompactOpts: () => ({ model: 'm', system: '' }),
      callbacks: {
        onEvent: (e) => events.push(e),
        onQueueChange: () => {},
        onUserTurn: (t) => userTurns.push(t),
        onBusyChange: () => {},
        onMessagesReset: () => {},
      },
    });
    controller.submit('A');
    controller.submit('B');
    await nextTick();
    await nextTick();
    expect(userTurns).toEqual(['A', 'B']); // A 抛错后 B 仍出队
    expect(events.some((e) => e.type === 'error' && e.error.includes('boom'))).toBe(true);
    expect(events.some((e) => e.type === 'completed')).toBe(true); // B 完成
    expect(controller.busy).toBe('idle');
  });

  it('idle compact → 压缩 → onMessagesReset 重灌（状态机 idle→compacting→idle）', async () => {
    const h = makeHarness();
    // 先跑完一条，灌 messagesRef（completed 全量回填）
    h.controller.submit('A');
    await nextTick();
    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');

    const result = await h.controller.compact();
    expect(result).toEqual({ before: 2, after: 1 }); // A 的 messages=2 条，mock 压成 1
    expect(h.messagesResets).toHaveLength(1);
    expect(h.busy).toContain('compacting');
    expect(h.controller.busy).toBe('idle');
  });

  it('忙时 compact → 排队（compactQueued），runLoop 结束后执行', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    const r = await h.controller.compact(); // 忙 → 排队
    expect(r).toBeNull();
    expect(h.compactMessages).not.toHaveBeenCalled();

    h.runAgent.gates.get('A')!.resolve();
    await nextTick();
    await nextTick(); // 等 runLoop finally → doCompact
    expect(h.compactMessages).toHaveBeenCalled(); // 排队的 compact 在 idle 后执行
  });

  it('compact 期间 submit → 入队 → compact 完成后 drain（互斥不并发）', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    h.runAgent.gates.get('A')!.resolve();
    await nextTick(); // idle

    // compact 用 gate 控制耗时
    const compactGate = deferred();
    h.compactMessages.mockImplementation(async () => {
      await compactGate.promise;
      return [{ role: 'user', content: '压缩后' }];
    });
    const compactP = h.controller.compact(); // idle → doCompact → busy=compacting
    await nextTick();
    expect(h.controller.busy).toBe('compacting');

    h.controller.submit('B'); // compact 期间入队
    expect(h.queue.at(-1)).toEqual(['B']);
    expect(h.controller.busy).toBe('compacting'); // 没切 running（互斥）

    compactGate.resolve();
    await compactP;
    await nextTick();
    expect(h.userTurns).toEqual(['A', 'B']); // B 在 compact 后出队
    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    expect(h.controller.busy).toBe('idle');
  });

  it('clear → 重置真相源 + 清队列；已清历史不被 aborted 回填"复活"', async () => {
    const h = makeHarness();
    h.controller.submit('A');
    await nextTick();
    h.controller.clear();
    expect(h.queue.at(-1)).toEqual([]);
    expect(h.controller.currentSessionId()).toBeNull();

    // A 的 aborted completed 到达，但 epoch 变 → 不回填，messagesRef 保持空
    h.runAgent.gates.get('A')!.resolve();
    await nextTick();

    h.controller.submit('B');
    await nextTick();
    h.runAgent.gates.get('B')!.resolve();
    await nextTick();
    const bCall = h.runAgent.calls.find((c) => c.text === 'B')!;
    expect(bCall.resumedMessages).toBeUndefined(); // 新会话，未带 A 的历史
  });

  it('resetSession → 载入会话真相源；后续 submit resumed 带载入历史', async () => {
    const h = makeHarness();
    const resumed: ECodeMessage[] = [
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
    ];
    h.controller.resetSession({
      id: 'old-id',
      task: '旧任务',
      createdAt: 'old',
      messages: resumed,
    });
    expect(h.controller.currentSessionId()).toBe('old-id');

    h.controller.submit('追问');
    await nextTick();
    h.runAgent.gates.get('追问')!.resolve();
    await nextTick();
    const call = h.runAgent.calls.find((c) => c.text === '追问')!;
    expect(call.resumedMessages).toHaveLength(2);
    expect(call.resumedMessages![0].role).toBe('user');
  });
});
