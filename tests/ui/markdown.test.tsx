import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { MarkdownRenderer } from '../../src/ui/markdown.js';

// cli-highlight 在 FORCE_COLOR=1 下给代码块输出 ANSI 颜色码（与字符内联），
// 断言代码内容前先剥离 ANSI（与 logo.test.tsx 同款正则）。
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('<MarkdownRenderer />', () => {
  it('streaming=true → 原样输出纯文本（不解析 markdown）', () => {
    const { lastFrame } = render(<MarkdownRenderer text="**未完成**的粗体" streaming />);
    expect(lastFrame()).toContain('**未完成**的粗体');
  });

  it('streaming=false → 解析粗体（去掉 ** 标记）', () => {
    const { lastFrame } = render(<MarkdownRenderer text="**完成**的粗体" />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('**');
    expect(frame).toContain('完成');
    expect(frame).toContain('的粗体');
  });

  it('完成态渲染代码块（含代码内容）', () => {
    const md = '示例：\n\n```ts\nconst x = 1;\n```\n';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    // 去掉 ANSI 颜色码后断言代码内容（cli-highlight 会给 keyword/number 上色）
    expect(stripAnsi(lastFrame() ?? '')).toContain('const x = 1;');
  });

  it('完成态渲染列表项', () => {
    const md = '- 苹果\n- 香蕉\n';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    expect(lastFrame()).toContain('苹果');
    expect(lastFrame()).toContain('香蕉');
  });
});
