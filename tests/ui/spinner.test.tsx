import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Spinner } from '../../src/ui/spinner.js';
import { SPINNER_FRAMES, T } from '../../src/ui/theme.js';

// 环境说明（React 19 + ink 7 + vitest 2 下两点适配）：
// 1. ink 把 setInterval 回调里的 setState 异步批处理，单次同步 advance 不会冲刷重渲染，
//    必须用 advanceTimersByTimeAsync；ink 的 commit 还比 timer 慢一个微任务批次，
//    故每次推进后再补一次 0ms 推进把渲染提交出来。
// 2. <Text color={hex}> 经 ink/chalk 转成 RGB truecolor 转义（38;2;R;G;B），
//    hex 字面量不会出现，故断言按 hex→RGB 比对。
const hexToRgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

describe('<Spinner />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('首帧渲染 braille 第一帧', () => {
    const { lastFrame } = render(<Spinner />);
    // lastFrame 含 ANSI 颜色码，断言子串即可
    expect(lastFrame()).toContain(SPINNER_FRAMES[0]);
  });

  it('80ms 后切到第二帧', async () => {
    const { lastFrame } = render(<Spinner />);
    expect(lastFrame()).toContain(SPINNER_FRAMES[0]);
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(0); // 冲刷 ink 渲染提交
    expect(lastFrame()).toContain(SPINNER_FRAMES[1]);
  });

  it('循环到最后帧后回到第一帧', async () => {
    const { lastFrame } = render(<Spinner />);
    await vi.advanceTimersByTimeAsync(80 * 10); // 走完 10 帧
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain(SPINNER_FRAMES[0]); // 回到首帧
  });

  it('默认色为 brand', () => {
    const { lastFrame } = render(<Spinner />);
    // brand 色在 ANSI 转义里以 RGB truecolor 出现
    expect(lastFrame()).toContain(hexToRgb(T.brand));
  });
});
