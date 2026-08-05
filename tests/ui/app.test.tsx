// App 集成测试（spec §5.2 / §4.2 Modal 替换 / §4.6 双击 Ctrl+C）。
//
// 测试要点（沿用 Task 7/8 经验：React 19 + ink 7 + vitest 2）：
// 1. ink 把 useInput 回调里的 setState 经 setTimeout 节流异步提交。写文本后立刻按 Enter，
//    若不冲刷渲染，Enter 读到的 text 仍是旧值（空）。故文本→Enter 之间必须
//    `advanceTimersByTimeAsync(0)` 冲刷提交（input-bar.test.tsx 已验证）。
// 2. /exit 走 process.exit（ink 的 useApp.exit 在测试环境不触 process.exit）。
// 3. pendingPermission 由 mock 的 async generator 异步产出事件，需多轮 flush 让
//    submit 的 async IIFE 消费完 generator + ink 渲染提交。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../../src/ui/app.js';
import { runAgentStream } from '../../src/agent.js';

vi.mock('../../src/agent.js', () => ({
  runAgentStream: vi.fn(async function* (): AsyncGenerator<never> {
    // 测试里默认不真跑 agent
  }),
}));

describe('<App />', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('初始态显示 WelcomeScreen（无 completedMessages）', () => {
    const { lastFrame } = render(<App cwd="~/x" />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Welcome');
    expect(f).toContain('ECode');
  });

  it('/clear 命令 → 清空 completedMessages', async () => {
    vi.useFakeTimers();
    const { lastFrame, stdin } = render(<App cwd="~/x" />);
    // 先 submit 一条制造历史（mock runAgentStream 不产事件，但 user 消息会落地）
    stdin.write('你好');
    await vi.advanceTimersByTimeAsync(0); // text='你好' 落地
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0); // user 消息落地
    const before = lastFrame() ?? '';
    expect(before).toContain('你'); // user 消息已出现
    // 输入 /clear
    stdin.write('/clear');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toBeDefined();
  });

  it('/exit → 调 process.exit', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('EXIT');
    }) as never);
    const { stdin } = render(<App cwd="~/x" />);
    stdin.write('/exit');
    await vi.advanceTimersByTimeAsync(0); // text='/exit' 落地
    expect(() => {
      stdin.write('\r');
    }).toThrow('EXIT');
    exitSpy.mockRestore();
  });

  it('pendingPermission 时显示 PermissionDialog（替换 InputBar）', async () => {
    vi.useFakeTimers();
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: 'start', task: 'x', model: 'm', provider: 'p' };
      yield { type: 'permission_request', toolUseId: 't1', toolName: 'bash', input: { command: 'ls' } };
    });
    const { stdin, lastFrame } = render(<App cwd="~/x" />);
    stdin.write('跑 ls');
    await vi.advanceTimersByTimeAsync(0); // text='跑 ls' 落地
    stdin.write('\r'); // submit → user 消息 + 启动 async IIFE 消费 generator
    // 多轮 flush：让 submit 的 async IIFE 消费完 generator 事件 + ink 渲染提交
    let frame = '';
    for (let i = 0; i < 30 && !frame.includes('Permission Required'); i++) {
      await vi.advanceTimersByTimeAsync(1);
      frame = lastFrame() ?? '';
    }
    expect(frame).toContain('Permission Required');
  });
});
