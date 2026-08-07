// InputBar 测试（spec §5.3 / §8.4）。
// 键盘测试要点（同 permission-dialog.test.tsx 的 Task 7 经验，React 19 + ink 7 + vitest 2）：
// 1. ink 把 useInput 回调里的 setState 经 setTimeout 节流异步提交，stdin.write 返回时
//    lastFrame() 读到的还是旧帧。必须用 fake timers + advanceTimersByTimeAsync(0)
//    把渲染提交冲刷出来（permission-dialog 已验证此组合）。
// 2. useInput 内部用 useEffectEvent（React 19）包裹回调，始终拿到最新 state 闭包，
//    故连续 write(文本) → write(\r) 的提交链能读到上一轮已提交的 text。
// 3. ↑ 用完整 CSI 序列 '[A'（裸 '[A' 会被当普通字符追加到输入）；
//    Enter 用 '\r'（完整序列当场 emit，无需 escape flush）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { InputBar } from '../../src/ui/input-bar.js';
import { SYMBOLS } from '../../src/ui/theme.js';

describe('<InputBar />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('显示 ❯ 提示符 + 当前输入', async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    stdin.write('hi');
    await vi.advanceTimersByTimeAsync(0); // 冲刷 ink 渲染提交
    expect(lastFrame()).toContain(SYMBOLS.user);
    expect(lastFrame()).toContain('hi');
  });

  it('Enter → onSubmit(当前文本) + 清空', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('hello');
    await vi.advanceTimersByTimeAsync(0); // text='hello' 落地
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0); // onSubmit + 清空落地
    expect(onSubmit).toHaveBeenCalledWith('hello');
    // 提交后输入框清空（不含 hello）
    expect(lastFrame()).not.toContain('hello');
  });

  it('空输入 Enter 不提交', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('历史：提交两次后 ↑ 调出上一条', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('first');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('second');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('[A'); // ↑ —— 完整 CSI 序列（ESC + [A）
    await vi.advanceTimersByTimeAsync(0); // 历史定位落地
    expect(lastFrame()).toContain('second');
  });

  it('disabled=true → 显示 ctrl+c to interrupt，不显输入提示', () => {
    const { lastFrame } = render(<InputBar onSubmit={vi.fn()} disabled />);
    const f = lastFrame() ?? '';
    expect(f.toLowerCase()).toContain('interrupt');
  });
});
