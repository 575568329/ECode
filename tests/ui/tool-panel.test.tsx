import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolRunning, ToolDone } from '../../src/ui/tool-panel.js';
import { SYMBOLS } from '../../src/ui/theme.js';

describe('ToolRunning', () => {
  it('显示 ▸ + 工具名 + 参数', () => {
    const { lastFrame } = render(<ToolRunning name="bash" arg="npm test" />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.tool);
    expect(f).toContain('bash');
    expect(f).toContain('npm test');
  });
});

describe('ToolDone', () => {
  it('bash 成功 → 前 3 行 + ... N more lines（超过 3 行时折叠）', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.success);
    expect(f).toContain('line1');
    expect(f).toContain('line2');
    expect(f).toContain('line3');
    expect(f).toContain('… +2 more lines'); // 5-3=2
    expect(f).toContain('(ctrl+o 展开)'); // 可发现性提示
    expect(f).not.toContain('line4');
  });

  it('bash 成功 ≤3 行 → 全显示无折叠提示', () => {
    const content = 'a\nb\nc';
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={false} />);
    expect(lastFrame()).not.toContain('more lines');
  });

  it('bash 错误 → 前 5 行（错误栈关键信息常在后面，多给几行）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `err${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={true} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.error);
    expect(f).toContain('err0');
    expect(f).toContain('err4');
    expect(f).toContain('… +3 more lines'); // 8-5=3
  });

  it('read_file → 只显 "Read N lines"（不显内容主体）', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const { lastFrame } = render(<ToolDone name="read_file" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toMatch(/Read \d+ lines/);
    expect(f).not.toContain('const x');
  });

  it('edit_file → 完整内容不折叠（diff 是精华）', () => {
    const content = '- old\n+ new\n+ newer';
    const { lastFrame } = render(<ToolDone name="edit_file" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('- old');
    expect(f).toContain('+ new');
    expect(f).not.toContain('more lines');
  });

  it('write_file 超 10 行 → 前 10 行 + 折叠提示（对齐 CC write 阈值）', () => {
    const content = Array.from({ length: 13 }, (_, i) => `line${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="write_file" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('line0');
    expect(f).toContain('line9'); // 第 10 行在
    expect(f).not.toContain('line10'); // 第 11 行被裁
    expect(f).toContain('… +3 more lines'); // 13-10=3
  });

  it('write_file ≤10 行 → 完整不折叠', () => {
    const content = Array.from({ length: 8 }, (_, i) => `line${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="write_file" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('line7');
    expect(f).not.toContain('more lines');
  });

  it('grep → 前 3 行匹配 + 提示含总命中数（of N matches）', () => {
    const content = 'a.ts:1: TODO\nb.ts:2: TODO\nc.ts:3: TODO\nd.ts:4: TODO';
    const { lastFrame } = render(<ToolDone name="grep" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('a.ts:1: TODO');
    expect(f).toContain('of 4 matches'); // 总命中数（不只被裁数）
    expect(f).toContain('(ctrl+o 展开)');
  });

  it('glob 多文件 → 完全折叠 "Found N files" 单行（不列文件，对齐 CC）', () => {
    const content = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';
    const { lastFrame } = render(<ToolDone name="glob" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Found 3 files');
    expect(f).not.toContain('src/a.ts'); // 不列文件名（清单去 Ctrl+O 转录看）
    expect(f).not.toContain('more lines');
  });

  it('glob 单文件 / 空命中 → 原样显示（不报 Found 1 files）', () => {
    const content = '未找到匹配文件。';
    const { lastFrame } = render(<ToolDone name="glob" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('未找到匹配文件。');
    expect(f).not.toContain('Found');
  });

  it('bash content 尾部空行 → 不渲染空 ↳ 行（execSync 输出常带尾 \\n）', () => {
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const content = 'line1\nline2\n'; // 尾 \n → split 出末尾空串 → 渲染空 ↳ 行（噪声）
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={false} />);
    const f = stripAnsi(lastFrame() ?? '');
    const arrowLines = f.split('\n').filter((l) => l.includes('↳'));
    expect(arrowLines.length).toBe(2); // 只有 line1/line2 两行，不是 3 行（含空 ↳）
    for (const l of arrowLines) {
      expect(l.split('↳')[1].trim().length).toBeGreaterThan(0); // 每行箭头后必有内容
    }
  });
});

describe('ToolDone Inline/Block 双模式（Phase 2）', () => {
  it('read_file → Inline（无边框字符 │，单行摘要）', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const { lastFrame } = render(
      <ToolDone name="read_file" content={content} isError={false} input={{ path: 'src/index.ts' }} />,
    );
    const f = lastFrame() ?? '';
    // Inline 模式不渲染左边框
    expect(f).not.toContain('│');
    // 仍包含摘要和路径参数
    expect(f).toMatch(/Read \d+ lines/);
    expect(f).toContain('src/index.ts');
  });

  it('bash 多行 → Block（含左边框字符 │）', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const { lastFrame } = render(
      <ToolDone name="bash" content={content} isError={false} input={{ command: 'npm test' }} />,
    );
    const f = lastFrame() ?? '';
    // Block 模式渲染左边框
    expect(f).toContain('│');
    expect(f).toContain('npm test');
  });

  it('error → Block（含左边框字符 │，error 图标）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `err${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={true} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('│');
    expect(f).toContain(SYMBOLS.error);
  });
});
