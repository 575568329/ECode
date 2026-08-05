// WelcomeScreen 测试（spec §8.4①⑩ 双栏欢迎面板 + 窄终端降级）。
// 纯展示组件，无键盘输入，不需 fake timers（同 status-bar.test.tsx 模式）。
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { WelcomeScreen } from '../../src/ui/welcome-screen.js';
import type { LoadStatus } from '../../src/ui/welcome-screen.js';

const loadStatus: LoadStatus = {
  claudeMd: { ok: true, lines: 142 },
  provider: { ok: true, label: 'deepseek-v3 @ deepseek' },
};

describe('<WelcomeScreen />', () => {
  it('显示标题 + Welcome + 加载状态', () => {
    const { lastFrame } = render(
      <WelcomeScreen version="0.4.0" loadStatus={loadStatus} cwd="~/projects/my-app" />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('ECode');
    expect(f).toContain('0.4.0');
    expect(f).toContain('Welcome');
    expect(f).toContain('CLAUDE.md');
    expect(f).toContain('142');
    expect(f).toContain('deepseek-v3 @ deepseek');
    expect(f).toContain('~/projects/my-app');
  });

  it('右栏含 Commands（/help /model /clear）+ Shortcuts', () => {
    const { lastFrame } = render(
      <WelcomeScreen version="0.4.0" loadStatus={loadStatus} cwd="x" />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('/help');
    expect(f).toContain('/model');
    expect(f).toContain('/clear');
    expect(f).toContain('Shortcuts');
  });

  it('不显示历史会话列表（噪声）', () => {
    const { lastFrame } = render(
      <WelcomeScreen version="0.4.0" loadStatus={loadStatus} cwd="x" />,
    );
    expect(lastFrame()).not.toContain('Recent sessions');
    expect(lastFrame()).not.toContain('会话列表');
  });

  it('narrow=true → 隐藏右栏（无 Commands 标题）', () => {
    const { lastFrame } = render(
      <WelcomeScreen version="0.4.0" loadStatus={loadStatus} cwd="x" narrow />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Welcome');
    // 窄模式不显 shortcuts 段（commands 仍可能有简化，但无 Shortcuts 标题）
    expect(f).not.toContain('Shortcuts');
  });
});
