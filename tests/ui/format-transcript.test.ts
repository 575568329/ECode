// sessionMessagesToTranscript 单测：DisplayMessage[] → 精简分组的转录纯文本（pager/less 输入）。
// 纯函数。新逻辑（B+ 方案，docs/20260806232155）：
//   - 按 user 提问分组，只输出「被折叠/裁剪的工具完整 content」（主界面看不到的）。
//   - 跳过 assistant / warning / error / edit_file / 未裁剪的单工具。
//   - 无折叠工具的轮次整体跳过；空结果 → 空串（调用方据此不进 pager）。
import { describe, it, expect } from 'vitest';
import { sessionMessagesToTranscript } from '../../src/ui/format-transcript.js';
import type { DisplayMessage } from '../../src/ui/types.js';

// 去 ANSI 转义，断言纯文本结构（测试专用辅助）。
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---- 消息构造器（就近构造，无共享可变状态）----
const user = (text: string, id = 'u'): DisplayMessage => ({ kind: 'user', id, text });
const assistant = (text: string, id = 'a'): DisplayMessage => ({ kind: 'assistant', id, text });
const warning = (text: string, id = 'w'): DisplayMessage => ({ kind: 'warning', id, text });
const errorMsg = (text: string, id = 'e'): DisplayMessage => ({ kind: 'error', id, text });

const tool = (
  name: string,
  content: string,
  opts?: { isError?: boolean; input?: Record<string, unknown> },
  id = 't',
): DisplayMessage => ({
  kind: 'tool',
  id,
  name,
  content,
  isError: opts?.isError ?? false,
  input: opts?.input,
});

const group = (
  tools: { name: string; content: string; isError?: boolean; input?: Record<string, unknown> }[],
  id = 'g',
): DisplayMessage => ({
  kind: 'tool_group',
  id,
  tools: tools.map((t) => ({ name: t.name, content: t.content, isError: t.isError ?? false, input: t.input })),
});

describe('sessionMessagesToTranscript · 精简分组模式', () => {
  it('空数组 → 空串（不进 pager）', () => {
    expect(sessionMessagesToTranscript([])).toBe('');
  });

  it('仅 user/assistant/warning（无折叠工具）→ 空串（精简，无关键内容）', () => {
    expect(sessionMessagesToTranscript([user('hi'), assistant('hello'), warning('注意')])).toBe('');
  });

  it('user + tool_group → 对话 1 锚点 + 提问摘要 + 各工具完整 content', () => {
    const t = sessionMessagesToTranscript([
      user('读 package.json 和 agent.ts'),
      group([
        { name: 'read_file', content: 'PKG内容', input: { path: 'package.json' } },
        { name: 'read_file', content: 'AGENT内容', input: { path: 'agent.ts' } },
      ]),
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('对话 1');
    expect(plain).toContain('读 package.json 和 agent.ts');
    expect(plain).toContain('read_file');
    expect(plain).toContain('package.json'); // summarizeArg(read_file)=path
    expect(plain).toContain('PKG内容');
    expect(plain).toContain('AGENT内容');
  });

  it('两轮各自有 tool_group → 对话 1 / 对话 2 两个锚点', () => {
    const t = sessionMessagesToTranscript([
      user('q1'),
      group([{ name: 'read_file', content: 'A', input: { path: 'a.ts' } }]),
      user('q2'),
      group([{ name: 'read_file', content: 'B', input: { path: 'b.ts' } }]),
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('对话 1');
    expect(plain).toContain('对话 2');
    expect(plain).toContain('q1');
    expect(plain).toContain('q2');
    expect(plain).toContain('A');
    expect(plain).toContain('B');
  });

  it('assistant 文本不出现（主界面已 markdown 渲染）', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      assistant('我帮你读取'),
      group([{ name: 'read_file', content: 'X', input: { path: 'x.ts' } }]),
      assistant('读完了'),
    ]);
    const plain = stripAnsi(t);
    expect(plain).not.toContain('我帮你读取');
    expect(plain).not.toContain('读完了');
    expect(plain).not.toContain('ECode'); // assistant 标题也不出现
  });

  it('warning / error 不出现', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      warning('注意'),
      group([{ name: 'read_file', content: 'X', input: { path: 'x.ts' } }]),
      errorMsg('boom'),
    ]);
    const plain = stripAnsi(t);
    expect(plain).not.toContain('注意');
    expect(plain).not.toContain('boom');
  });

  it('edit_file 不展开（主界面已完整显示 diff）→ 整轮无折叠 → 空串', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      tool('edit_file', 'diff -一大段', { input: { path: 'a.ts' } }),
    ]);
    expect(stripAnsi(t)).toBe('');
  });

  it('read_file 单独出现 → 展开（主界面只摘要行数，完整 content 丢失）', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      tool('read_file', '文件全文多行内容', { input: { path: 'a.ts' } }),
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('对话 1');
    expect(plain).toContain('文件全文多行内容');
  });

  it('多行 bash（>3 行被裁剪）→ 展开；单行 bash（未裁剪）→ 跳过 → 空串', () => {
    const longBash = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n');
    const tLong = sessionMessagesToTranscript([
      user('q'),
      tool('bash', longBash, { input: { command: 'ls -la' } }),
    ]);
    expect(stripAnsi(tLong)).toContain('行10'); // 完整含尾部（防假绿：主界面 bash 只显前 3 行）

    const tShort = sessionMessagesToTranscript([
      user('q'),
      tool('bash', '仅一行输出', { input: { command: 'pwd' } }),
    ]);
    expect(stripAnsi(tShort)).toBe(''); // 未裁剪 → 无折叠 → 整轮跳过
  });

  it('glob ≥2 文件 → 展开；单文件 → 跳过 → 空串', () => {
    const t2 = sessionMessagesToTranscript([
      user('q'),
      tool('glob', 'a.ts\nb.ts', { input: { pattern: '*.ts' } }),
    ]);
    expect(stripAnsi(t2)).toContain('a.ts');

    const t1 = sessionMessagesToTranscript([
      user('q'),
      tool('glob', 'only.ts', { input: { pattern: '*.ts' } }),
    ]);
    expect(stripAnsi(t1)).toBe('');
  });

  it('无折叠工具的轮次不计入对话编号（中间空轮被跳过）', () => {
    const t = sessionMessagesToTranscript([
      user('empty1'),
      assistant('闲聊'), // 无折叠 → 整轮跳过
      user('real1'),
      group([{ name: 'read_file', content: 'A', input: { path: 'a.ts' } }]), // 对话 1
      user('empty2'),
      warning('x'), // 无折叠 → 整轮跳过
      user('real2'),
      group([{ name: 'read_file', content: 'B', input: { path: 'b.ts' } }]), // 对话 2
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('对话 1');
    expect(plain).toContain('real1');
    expect(plain).toContain('对话 2');
    expect(plain).toContain('real2');
    expect(plain).not.toContain('对话 3');
    expect(plain).not.toContain('empty1');
    expect(plain).not.toContain('empty2');
    expect(plain).not.toContain('闲聊');
  });

  it('多行提问 → 锚点显示首行摘要', () => {
    const t = sessionMessagesToTranscript([
      user('第一行提问\n第二行提问'),
      group([{ name: 'read_file', content: 'X', input: { path: 'x.ts' } }]),
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('第一行提问');
  });

  it('保留 ANSI 着色（给 less -R 渲染）', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      group([{ name: 'read_file', content: 'X', input: { path: 'x.ts' } }]),
    ]);
    expect(t).toContain('\x1b['); // 含 ANSI 转义（不限具体色值，避免绑定实现细节）
  });

  it('tool_group 含错误工具 → 该工具标 ✗ 并展开完整 content', () => {
    const t = sessionMessagesToTranscript([
      user('q'),
      group([
        { name: 'read_file', content: 'OK内容', input: { path: 'a.ts' } },
        { name: 'bash', content: '错误堆栈', isError: true, input: { command: 'bad' } },
      ]),
    ]);
    const plain = stripAnsi(t);
    expect(plain).toContain('✗');
    expect(plain).toContain('bash');
    expect(plain).toContain('错误堆栈');
  });
});
