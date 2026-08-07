// StatusBar 测试（spec §8.4⑧ 状态栏 / §8.1 Ctx 三色阈值）。
// 环境说明（React 19 + ink 7 + vitest 2，同 spinner.test.tsx 的两点适配）：
// 1. <Text color={hex}> 经 ink/chalk 转成 RGB truecolor 转义（38;2;R;G;B），
//    hex 字面量不会出现，故 Ctx warning 色断言按 hex→RGB 比对（brief 原文 fab387 不可用）。
// 2. brief 测试 base 未传 startedAt（实现里算耗时需要），补 Date.now() 避免 NaN:NaN 显示。
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../src/ui/status-bar.js';
import { T } from '../../src/ui/theme.js';

// hex → "R;G;B" truecolor 三元组，匹配 ink 在 ANSI 转义里的颜色编码。
const hexToRgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

const base = {
  usage: { inputTokens: 12500, outputTokens: 3200 },
  model: 'deepseek-v3',
  provider: 'deepseek',
  startedAt: Date.now(),
};

describe('<StatusBar />', () => {
  it('含 token 段（↑input ↓output）+ model @ provider', () => {
    const { lastFrame } = render(<StatusBar {...base} ctxPercent={45} phase="idle" />);
    const f = lastFrame() ?? '';
    expect(f).toContain('↑');
    expect(f).toContain('12.5K'); // 12500 → 12.5K
    expect(f).toContain('deepseek-v3 @ deepseek');
  });

  it('Ctx ≤80% → 动态段 "/help for commands"（idle）', () => {
    const { lastFrame } = render(<StatusBar {...base} ctxPercent={45} phase="idle" />);
    expect(lastFrame()).toContain('/help');
  });

  it('Ctx >80% → Ctx% 变 warning 色（RGB 出现在 ANSI）+ streaming 动态段', () => {
    const { lastFrame } = render(<StatusBar {...base} ctxPercent={85} phase="streaming" />);
    const f = lastFrame() ?? '';
    expect(f).toContain('ctrl+c to interrupt');
    // warning 色 #FAB387 经 ink 转 RGB truecolor（38;2;250;179;135），hex 字面量不会出现。
    expect(f).toContain(hexToRgb(T.warning));
  });

  it('phase=exit-window → "press ctrl+c again to exit"', () => {
    const { lastFrame } = render(<StatusBar {...base} ctxPercent={50} phase="exit-window" />);
    expect(lastFrame()).toContain('press ctrl+c again');
  });

  it('费用段显示（token 计费估算，非零）', () => {
    const { lastFrame } = render(<StatusBar {...base} ctxPercent={45} phase="idle" />);
    expect(lastFrame()).toContain('$');
  });
});
