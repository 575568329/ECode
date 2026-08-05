import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { useAgentStream } from '../../src/ui/use-agent-stream.js';
import { runAgentStream } from '../../src/agent.js';
import type { AgentEvent } from '../../src/agent-events.js';

// 把"用户消息落地"逻辑也测到：submit 后 completedMessages 含 user 消息。
vi.mock('../../src/agent.js', () => ({
  runAgentStream: vi.fn(),
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
    // 立即完成的空事件流
    mocked.mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'start', task: 'hi', model: 'm', provider: 'p' };
      yield { type: 'completed', rounds: 1, toolCalls: 0, reason: 'done' };
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

  it('permission_request → pendingPermission 挂起；resolvePermission(allow_always) → gate 返回 allow 且 allow 列表记住', async () => {
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(
      async function* (
        task: string,
        opts?: { permissionGate?: { ask: (r: unknown) => Promise<string> } },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'start', task, model: 'm', provider: 'p' };
        yield { type: 'permission_request', toolUseId: 't1', toolName: 'bash', input: { command: 'x' } };
        const decision = opts?.permissionGate ? await opts.permissionGate.ask({}) : 'allow';
        yield { type: 'tool_call_start', id: 't1', name: 'bash' };
        yield { type: 'tool_result', id: 't1', name: 'bash', content: 'ok', isError: false };
        yield { type: 'completed', rounds: 1, toolCalls: 1, reason: 'done' };
        void decision;
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
});
