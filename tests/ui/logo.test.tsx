import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Logo } from '../../src/ui/logo.js';

describe('<Logo />', () => {
  it('渲染 5 行方块 E（含 3 条横杠 ███████ / █████）', () => {
    const { lastFrame } = render(<Logo />);
    const frame = lastFrame() ?? '';
    // 顶横、中横（█████）、底横各出现
    expect(frame).toContain('███████');
    expect(frame).toContain('█████');
  });

  it('含 prompt 三角 ▶ 和光标 _', () => {
    const { lastFrame } = render(<Logo />);
    expect(lastFrame()).toContain('▶');
    expect(lastFrame()).toContain('_');
  });

  it('共 5 行（E 字形：上横/竖/中横/竖/下横）', () => {
    const { lastFrame } = render(<Logo />);
    // 去掉 ANSI 码后按换行切，非空行应为 5
    const lines = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
  });
});
