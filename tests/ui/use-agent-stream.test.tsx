import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { useAgentStream } from '../../src/ui/use-agent-stream.js';
import { runAgentStream } from '../../src/agent.js';
import type { AgentEvent } from '../../src/agent-events.js';

// 把"用户消息落地"逻辑也测到：submit 后 completedMessages 含 user 消息。
vi.mock('../../src/agent.js', () => ({
  runAgentStream: vi.fn(),
  // controller 构造期访问 compactMessages（render 时），mock 必须导出它，否则 vitest mock 严格模式抛错
  compactMessages: vi.fn(),
}));

type Api = ReturnType<typeof useAgentStream>;

// 辅助：渲染一个消费 hook 的壳组件。
// 关键：把 api 写进 ref（每次渲染都刷新），测试侧据此读"最新"返回值。
// 不能用 useEffect([deps]) 只在挂载时交出去——那样 api 永远是首渲染的快照，
// 后续 state 更新（isRunning / completedMessages / pendingPermission）测不到。
function Harness({ apiRef }: { apiRef: React.MutableRefObject<Api | null> }) {
  const api = useAgentStream({ model: 'mock-model' });
  apiRef.current = api; // 每次渲染刷新，测试侧 apiRef.current 永远是最新
  return null;
}

describe('useAgentStream', () => {
  it('submit → 用户消息进入 completedMessages + 启动 runAgentStream', async () => {
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    // 立即完成的空事件流（completed 带续接字段，与真实 runAgentStream 一致）
    mocked.mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'start', task: 'hi', model: 'm', provider: 'p' };
      yield {
        type: 'completed',
        rounds: 1,
        toolCalls: 0,
        reason: 'done',
        sessionId: 'test-sess-1',
        messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: [{ type: 'text', text: '嗨' }] }],
        task: 'hi',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    } as never);

    const apiRef: React.MutableRefObject<Api | null> = { current: null };
    render(<Harness apiRef={apiRef} />);
    const api = () => apiRef.current as Api;

    api().submit('你好');
    // 让微任务/async 跑完
    await new Promise((r) => setTimeout(r, 50));

    expect(mocked).toHaveBeenCalledWith('你好', expect.objectContaining({ model: 'mock-model' }));
    expect(api().completedMessages.some((m) => m.kind === 'user' && m.text === '你好')).toBe(true);
    expect(api().isRunning).toBe(false);
  });

  it('permission_request → pendingPermission 挂起；resolvePermission(allow_always) → 核心层 add，allow 列表记住', async () => {
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(
      async function* (
        task: string,
        opts?: {
          permissionGate?: { ask: (r: unknown) => Promise<string> };
          allow?: { add: (toolName: string) => void };
        },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'start', task, model: 'm', provider: 'p' };
        yield { type: 'permission_request', toolUseId: 't1', toolName: 'bash', input: { command: 'x' } };
        // 模拟核心层（agent.ts）：仅 allow_always 记会话规则（🔴-2 修复后的契约，UI 不再 add）
        const decision = opts?.permissionGate ? await opts.permissionGate.ask({}) : 'allow_once';
        if (decision === 'allow_always' && opts?.allow) {
          opts.allow.add('bash');
        }
        yield { type: 'tool_call_start', id: 't1', name: 'bash' };
        yield { type: 'tool_result', id: 't1', name: 'bash', content: 'ok', isError: false };
        yield {
          type: 'completed',
          rounds: 1,
          toolCalls: 1,
          reason: 'done',
          sessionId: 'test-sess-perm',
          messages: [{ role: 'user', content: '跑 bash' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
          task: '跑 bash',
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      } as never,
    );

    const apiRef: React.MutableRefObject<Api | null> = { current: null };
    render(<Harness apiRef={apiRef} />);
    const api = () => apiRef.current as Api;

    api().submit('跑 bash');
    await new Promise((r) => setTimeout(r, 30));

    // 等待 pendingPermission 挂起
    await vi.waitFor(() => expect(api().pendingPermission).not.toBeNull());
    expect(api().pendingPermission?.toolName).toBe('bash');

    api().resolvePermission('allow_always');
    await new Promise((r) => setTimeout(r, 50));

    // allow_always 后 allow 列表含 bash（后续不再问）
    expect(api().isAllowAlways('bash')).toBe(true);
    expect(api().pendingPermission).toBeNull();
  });

  it('🔴-2：resolvePermission(allow)（本次放行）→ allow 列表不记住，下次仍会询问', async () => {
    // UI 侧 🔴-2 回归：旧版核心收到 'allow' 时无法区分本次/永久 → 无条件 add。
    // 修复后 UI 把 'allow' 透传为 'allow_once'，核心不 add → isAllowAlways 仍为 false。
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(
      async function* (
        task: string,
        opts?: {
          permissionGate?: { ask: (r: unknown) => Promise<string> };
          allow?: { add: (toolName: string) => void };
        },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'start', task, model: 'm', provider: 'p' };
        yield { type: 'permission_request', toolUseId: 't1', toolName: 'bash', input: { command: 'x' } };
        const decision = opts?.permissionGate ? await opts.permissionGate.ask({}) : 'allow_once';
        if (decision === 'allow_always' && opts?.allow) {
          opts.allow.add('bash');
        }
        yield { type: 'tool_call_start', id: 't1', name: 'bash' };
        yield { type: 'tool_result', id: 't1', name: 'bash', content: 'ok', isError: false };
        yield {
          type: 'completed',
          rounds: 1,
          toolCalls: 1,
          reason: 'done',
          sessionId: 'test-sess-perm-once',
          messages: [
            { role: 'user', content: '跑 bash' },
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          ],
          task: '跑 bash',
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      } as never,
    );

    const apiRef: React.MutableRefObject<Api | null> = { current: null };
    render(<Harness apiRef={apiRef} />);
    const api = () => apiRef.current as Api;

    api().submit('跑 bash');
    await new Promise((r) => setTimeout(r, 30));
    await vi.waitFor(() => expect(api().pendingPermission).not.toBeNull());

    api().resolvePermission('allow'); // 本次放行（UI 'allow' → 核心 'allow_once'）
    await new Promise((r) => setTimeout(r, 50));

    expect(api().isAllowAlways('bash')).toBe(false); // 🔴-2：本次放行不记住
    expect(api().pendingPermission).toBeNull();
  });

  it('abort → 中断正在跑的流', async () => {
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(
      async function* (task: string, opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
        yield { type: 'start', task, model: 'm', provider: 'p' };
        yield { type: 'text_delta', text: '部分' };
        // 模拟长跑：阻塞至 signal abort 才退出（否则生成器自然返回，loop 立刻结束测不到 running 态）
        if (opts?.signal) {
          await new Promise<void>((resolve) => {
            opts.signal!.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      } as never,
    );

    const apiRef: React.MutableRefObject<Api | null> = { current: null };
    render(<Harness apiRef={apiRef} />);
    const api = () => apiRef.current as Api;

    api().submit('hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(api().isRunning).toBe(true);

    api().abort();
    // abort 后 generation finally 把 isRunning 翻回 false
    await vi.waitFor(() => expect(api().isRunning).toBe(false));
  });

  it('连发两句 → 第二次 submit 带 resumed（复用 sessionId + 历史），/clear 后重置', async () => {
    // REPL 多轮续接闭环验证：首次无 resumed → completed 回传 → 第二次带 resumed → clear 重置
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockClear(); // 清除前 3 个测试的残留调用计数
    let callCount = 0;
    mocked.mockImplementation(
      async function* (task: string): AsyncGenerator<AgentEvent> {
        callCount++;
        yield { type: 'start', task, model: 'm', provider: 'p' };
        yield {
          type: 'completed',
          rounds: 1,
          toolCalls: 0,
          reason: 'done',
          sessionId: `sess-call-${callCount}`,
          messages: [
            { role: 'user', content: task },
            { role: 'assistant', content: [{ type: 'text', text: `回${callCount}` }] },
          ],
          task,
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      } as never,
    );

    const apiRef: React.MutableRefObject<Api | null> = { current: null };
    render(<Harness apiRef={apiRef} />);
    const api = () => apiRef.current as Api;

    // 第一次 submit → 无 resumed（新会话）
    api().submit('第一句');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect((mocked.mock.calls[0][1] as { resumed?: unknown }).resumed).toBeUndefined(); // 首次无 resumed

    // 第二次 submit → 带 resumed（复用第一轮的 sessionId + messages）
    api().submit('第二句');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked).toHaveBeenCalledTimes(2);
    const secondOpts = mocked.mock.calls[1][1] as { resumed?: { id: string } };
    expect(secondOpts.resumed).toBeDefined();
    expect(secondOpts.resumed!.id).toBe('sess-call-1'); // 复用第一轮的 sessionId

    // /clear 后第三次 submit → resumed 又变 undefined（新会话）
    api().clear();
    api().submit('第三句');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked).toHaveBeenCalledTimes(3);
    const thirdOpts = mocked.mock.calls[2][1] as { resumed?: unknown };
    expect(thirdOpts.resumed).toBeUndefined(); // clear 后重置
  });
});
