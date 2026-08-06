import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { MarkdownRenderer } from '../../src/ui/markdown.js';
import { displayWidth } from '../../src/ui/display-width.js';

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

describe('<MarkdownRenderer /> table 渲染', () => {
  it('表格 → 对齐列渲染，不显 raw 的 |--| 分隔行（default 分支会原样吐 markdown）', () => {
    const md = '| 里程碑 | 状态 |\n|--------|------|\n| M1 | 完成 |';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('里程碑');
    expect(f).toContain('M1');
    expect(f).toContain('完成');
    expect(f).not.toContain('---'); // raw 分隔行不应出现
    expect(f).not.toContain('|--'); // raw 表格边线不应出现
  });

  it('表格单元格内 **粗体** → 解析掉星号（表格 raw 时单元格内容连坐显示 **）', () => {
    const md = '| 名称 | 值 |\n|------|----|\n| **M1** | 完成 |';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('M1');
    expect(f).not.toContain('**'); // 表格解析后单元格 inline strong 生效，星号消失
  });
});

describe('<MarkdownRenderer /> list 内联渲染', () => {
  it('list 内 **粗体** → 解析掉星号（item.tokens 首层是 text 容器，真 inline 在 .tokens）', () => {
    const md = '- **配色**：17个\n- **符号**：单宽';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('配色');
    expect(f).toContain('符号');
    expect(f).not.toContain('**'); // 修复前：item.tokens[0].text 保留 **，漏星号
  });
});

describe('<MarkdownRenderer /> 表格中文列对齐', () => {
  it('表格中文列 → 各行显示宽度一致（│ 右边界对齐，按显示宽度非 length）', () => {
    const md = '| 名称 | 值 |\n|------|----|\n| 配色 | 17 |\n| 符号 | 单宽 |';
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const f = stripAnsi(lastFrame() ?? '');
    const lines = f.split('\n').filter((l) => l.includes('│'));
    expect(lines.length).toBeGreaterThan(0);
    // 修复前：padEnd 按 length，中文列错位 → 各行显示宽度参差
    // 修复后：padEndDisplay 按显示宽度 → 各行 │ 对齐，显示宽度一致
    const widths = lines.map((l) => displayWidth(l));
    const max = Math.max(...widths);
    for (const w of widths) {
      expect(w).toBe(max);
    }
  });
});
