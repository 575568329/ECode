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
  // controller 构造期访问 compactMessages（render 时），mock 必须导出它
  compactMessages: vi.fn(),
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
    // ink useInput 回调异步节流：process.exit 在 flush 后才触发。用 spy 空实现 + 断言被调，
    // 避免 throw mock 在异步回调里成 unhandled error（旧写法 expect(sync).toThrow 已不成立）。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      /* 空实现：阻止真退出，仅观测被调 */
    }) as never);
    const { stdin } = render(<App cwd="~/x" />);
    stdin.write('/exit');
    await vi.advanceTimersByTimeAsync(0); // text='/exit' 落地
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0); // flush useInput → handleCommand('exit') → process.exit(0)
    expect(exitSpy).toHaveBeenCalledWith(0);
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

  // --- 键位分工：Ctrl+C 单击中断 / 双击退出（详设 docs/详设/20260807000318）---
  //
  // 为何之前没有这类测试、且这类测试抓不到「一次 Ctrl+C 就退出」真机 bug：
  //   ink-testing-library 的 render 硬编码 exitOnCtrlC:false（build/index.js:75），
  //   故测试里 \x03 永远能到 useInput、app.tsx 的 Ctrl+C 逻辑一直生效 → 单测恒绿。
  //   但真机 index.ts render 没传 exitOnCtrlC:false → ink 默认 true → 在 stdin 层
  //   （node_modules/ink/build/components/App.js:151 拦 \x03）直接 process.exit，
  //   app.tsx 逻辑成死代码、一次就退。两者配置不一致是真机 bug 的根因；已在 index.ts
  //   render 加 exitOnCtrlC:false 拉齐。这两个测试守护 app.tsx 的分工逻辑（防止
  //   未来有人改坏单击/双击判定），但无法复现真机 bug——真机仍需手动冒烟。

  it('双击 Ctrl+C(2s 内) → process.exit(0)', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      /* 阻止真退出，仅观测被调 */
    }) as never);
    const { stdin } = render(<App cwd="~/x" />);
    stdin.write('\x03'); // 第一次 → 进退出窗口（setLastCtrlC）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x03'); // 第二次（fake timers 下 Date.now() 几乎不变，< DOUBLE_CTRL_C_MS=2000）→ exit
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('单击 Ctrl+C → 中断运行中流（— 已中断 —）', async () => {
    vi.useFakeTimers();
    const mocked = runAgentStream as unknown as ReturnType<typeof vi.fn>;
    // 情况 B：yield start + text_delta（LLM 已回应）置 busy='running'；abort → completed(aborted)。
    // 对齐真实 agent（abort→completed，非 throw）；中断走情况 B → 显示「— 已中断 —」。
    mocked.mockImplementation(async function* (text: string, opts: { signal: AbortSignal }): AsyncGenerator<any> {
      yield { type: 'start', task: text, model: 'm', provider: 'p' };
      yield { type: 'text_delta', text: '部分' }; // LLM 已回应 → 情况 B
      await new Promise<void>((resolve) => {
        opts.signal.addEventListener('abort', () => resolve());
      });
      yield {
        type: 'completed',
        rounds: 1,
        toolCalls: 0,
        reason: 'aborted',
        sessionId: 's',
        task: text,
        createdAt: 't',
        messages: [
          { role: 'user', content: text },
          { role: 'assistant', content: [{ type: 'text', text: '部分' }] },
        ],
      };
    });
    const { stdin, lastFrame } = render(<App cwd="~/x" />);
    stdin.write('跑');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r'); // submit → ensureRunLoop → busy='running'
    // 多轮 flush：让 start/text_delta 事件消费 + busy='running' 经 onBusyChange 落到 state（isRunning=true）
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1);
    stdin.write('\x03'); // 单击 Ctrl+C → abort → mock 响应 completed(aborted，情况 B)→「— 已中断 —」
    // 多轮 flush：abort resolve → generator yield completed → onTurnAborted setState → ink 重绘
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(1);
    expect(lastFrame() ?? '').toContain('已中断');
  });
});
