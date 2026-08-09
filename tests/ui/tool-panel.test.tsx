import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolRunning, ToolDone, foldContent } from '../../src/ui/tool-panel.js';
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

  it('bash 错误 → 前 3 行（统一阈值，不区分 error/success，对标 CC/opencode）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `err${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={true} />);
    const f = lastFrame() ?? '';
    expect(f).toContain(SYMBOLS.error);
    expect(f).toContain('err0');
    expect(f).toContain('err2');
    expect(f).toContain('… +5 more lines'); // 8-3=5（统一 3 行，不再 isError 多给）
    expect(f).not.toContain('err3');
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

  it('edit_file 成功 → 渲染 +/- 着色 diff + Added/Removed 摘要（对标 CC StructuredDiff）', () => {
    const content = '已替换。文件 x.ts 更新成功。\n\n@@ -1,2 +1,2 @@\n-old\n+new';
    const { lastFrame } = render(
      <ToolDone name="edit_file" content={content} isError={false} input={{ path: 'x.ts' }} />,
    );
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).toContain('edit_file');
    expect(f).toContain('x.ts');
    expect(f).toContain('+1 / -1'); // Added N / Removed M 摘要（精确格式，区别于 @@ 行的 +1,2）
    expect(f).toContain('+new'); // 新增行（diffAdded 着色，strip 后子串仍在）
    expect(f).toContain('-old'); // 删除行（diffRemoved 着色）
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

  it('ls 多条目 → 折叠 "Listed N entries" 单行（对标 glob，不逐条铺屏）', () => {
    const content = '.claude\n.ecode\nsrc\ntests\ndocs';
    const { lastFrame } = render(<ToolDone name="ls" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Listed 5 entries');
    expect(f).not.toContain('.claude'); // 不逐条列（清单去 Ctrl+O 转录看）
    expect(f).not.toContain('more lines');
  });

  it('ls 单条目 → 原样（不报 Listed 1 entries）', () => {
    const content = 'only-one';
    const { lastFrame } = render(<ToolDone name="ls" content={content} isError={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('only-one');
    expect(f).not.toContain('Listed');
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

  it('error → Block（含左边框字符 │，error 图标，统一 3 行截断）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `err${i}`).join('\n');
    const { lastFrame } = render(<ToolDone name="bash" content={content} isError={true} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('│');
    expect(f).toContain(SYMBOLS.error);
    expect(f).toContain('… +5 more lines');
  });
});

// ---- foldContent 策略表 + folded 标志直接测试 ----

describe('foldContent 策略表', () => {
  it('summary 模式 ≥2 条目 → 折叠成单行摘要 + folded=true', () => {
    const r = foldContent('read_file', false, 'line1\nline2\nline3');
    expect(r.lines).toEqual(['Read 3 lines']);
    expect(r.omitted).toBe(0);
    expect(r.folded).toBe(true);
  });

  it('summary 模式 read_file 单行 → 仍摘要（minEntries=1）+ folded=true', () => {
    const r = foldContent('read_file', false, 'single line');
    expect(r.lines).toEqual(['Read 1 lines']);
    expect(r.folded).toBe(true);
  });

  it('summary 模式 glob 多文件 → Found N files', () => {
    const r = foldContent('glob', false, 'a.ts\nb.ts\nc.ts');
    expect(r.lines).toEqual(['Found 3 files']);
    expect(r.folded).toBe(true);
  });

  it('summary 模式 ls 多条目 → Listed N entries', () => {
    const r = foldContent('ls', false, 'src\ntests\ndocs');
    expect(r.lines).toEqual(['Listed 3 entries']);
    expect(r.folded).toBe(true);
  });

  it('head 模式 grep 超行 → 截断 + label 含总命中数 + folded=true', () => {
    const r = foldContent('grep', false, 'a.ts:1: x\nb.ts:2: x\nc.ts:3: x\nd.ts:4: x');
    expect(r.lines.length).toBe(3);
    expect(r.omitted).toBe(1);
    expect(r.label).toBe('of 4 matches'); // N 被替换
    expect(r.folded).toBe(true);
  });

  it('head 模式 bash 超行 → 前 3 行 + more lines', () => {
    const r = foldContent('bash', false, 'a\nb\nc\nd\ne');
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.omitted).toBe(2);
    expect(r.label).toBe('more lines');
    expect(r.folded).toBe(true);
  });

  it('head 模式不超行 → 完整 + folded=false', () => {
    const r = foldContent('bash', false, 'a\nb\nc');
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.omitted).toBe(0);
    expect(r.folded).toBe(false);
  });

  it('full 模式 edit_file → 完整不折叠 + folded=false', () => {
    const r = foldContent('edit_file', false, '- old\n+ new\n+ newer');
    expect(r.lines).toEqual(['- old', '+ new', '+ newer']);
    expect(r.folded).toBe(false);
  });

  it('full 模式 edit_file 失败(isError=true) → 降级 head(3) 折叠（失败回喂整文件带行号 ≤50K 会刷屏）', () => {
    const lines = ['未找到指定文本。', '', '文件当前内容（带行号）：', ...Array.from({ length: 10 }, (_, i) => `${i + 1}: line`)];
    const longErr = lines.join('\n'); // 13 行（错误提示 + 整文件带行号，模拟 edit-file.ts:35 失败回喂）
    const r = foldContent('edit_file', true, longErr);
    expect(r.folded).toBe(true);
    expect(r.lines.length).toBe(3); // 前 3 行（错误提示），全文截断
    expect(r.omitted).toBe(lines.length - 3); // 13-3=10
    expect(r.label).toBe('more lines');
  });

  it('未知工具 → 默认 head(3) 兜底 + folded=true', () => {
    const r = foldContent('mcp_custom_tool', false, 'a\nb\nc\nd');
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.omitted).toBe(1);
    expect(r.label).toBe('more lines');
    expect(r.folded).toBe(true);
  });

  it('未知工具 ≤3 行 → 完整 + folded=false', () => {
    const r = foldContent('unknown_tool', false, 'a\nb');
    expect(r.lines).toEqual(['a', 'b']);
    expect(r.folded).toBe(false);
  });
});

// ---- 子代理路由 via-line（R4）：Task 气泡显示模型 + 路由来源，§16.5 ----

describe('ToolDone · 子代理路由 via-line（R4）', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('Task + complexity 来源 → 渲染 via-line（via 复杂度路由 → model）', () => {
    const { lastFrame } = render(
      <ToolDone
        name="Task"
        content={'子代理结论行1\n子代理结论行2'}
        isError={false}
        metadata={{ routingSource: 'complexity', model: 'glm-5.2', provider: 'zhipu' }}
      />,
    );
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).toContain('via 复杂度路由');
    expect(f).toContain('glm-5.2');
  });

  it('Task + persona 来源 → via 人设', () => {
    const { lastFrame } = render(
      <ToolDone
        name="Task"
        content={'结论A\n结论B'}
        isError={false}
        metadata={{ routingSource: 'persona', model: 'glm-4.6' }}
      />,
    );
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).toContain('via 人设');
    expect(f).toContain('glm-4.6');
  });

  it('Task + rule 来源 → via 路由规则', () => {
    const { lastFrame } = render(
      <ToolDone
        name="Task"
        content={'x\ny'}
        isError={false}
        metadata={{ routingSource: 'rule', model: 'deepseek-chat' }}
      />,
    );
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).toContain('via 路由规则');
  });

  it('Task + default 来源 → 不渲染 via-line（default=没路由，避免噪声）', () => {
    const { lastFrame } = render(
      <ToolDone
        name="Task"
        content={'x\ny'}
        isError={false}
        metadata={{ routingSource: 'default', model: 'glm-5.2' }}
      />,
    );
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).not.toContain('via ');
  });

  it('Task 无 metadata → 不渲染 via-line（向后兼容，其他工具不填 metadata）', () => {
    const { lastFrame } = render(<ToolDone name="Task" content={'x\ny'} isError={false} />);
    const f = stripAnsi(lastFrame() ?? '');
    expect(f).not.toContain('via ');
  });
});
