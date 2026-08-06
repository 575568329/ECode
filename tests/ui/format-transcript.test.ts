// sessionMessagesToTranscript 单测：DisplayMessage[] → 带 ANSI 颜色的转录纯文本（pager/less 输入）。
// 纯函数。与 renderCompleted（chat-view.tsx）共享角色/符号约定；工具结果取完整 content
// （不走 foldContent 裁剪——pager 的意义就是看完整）。
import { describe, it, expect } from 'vitest';
import { sessionMessagesToTranscript } from '../../src/ui/format-transcript.js';
import type { DisplayMessage } from '../../src/ui/types.js';

// 去 ANSI 转义，断言纯文本结构（测试专用辅助）。
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const user = (text: string): DisplayMessage => ({ kind: 'user', id: 'u1', text });
const assistant = (text: string): DisplayMessage => ({ kind: 'assistant', id: 'a1', text });
const tool = (
  name: string,
  content: string,
  opts?: { isError?: boolean; input?: Record<string, unknown> },
): DisplayMessage => ({
  kind: 'tool',
  id: 't1',
  name,
  content,
  isError: opts?.isError ?? false,
  input: opts?.input,
});

describe('sessionMessagesToTranscript', () => {
  it('空消息数组 → 空串', () => {
    expect(sessionMessagesToTranscript([])).toBe('');
  });

  it('user 消息 → ❯ 你 + 内容', () => {
    const t = sessionMessagesToTranscript([user('帮我读 package.json')]);
    const plain = stripAnsi(t);
    expect(plain).toContain('❯ 你');
    expect(plain).toContain('帮我读 package.json');
  });

  it('assistant 消息 → ◆ ECode + 文本', () => {
    const t = sessionMessagesToTranscript([assistant('我来读取 package.json')]);
    const plain = stripAnsi(t);
    expect(plain).toContain('◆ ECode');
    expect(plain).toContain('我来读取 package.json');
  });

  it('tool 成功 → ✓ + 工具名 + (参数) + 完整 content（不裁剪）', () => {
    // 防假绿：10 行 content，foldContent 的 bash 会裁到 3 行；
    // transcript 必须完整保留第 1 行和第 10 行 → 证明走完整 content 而非 foldContent。
    const content = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`).join('\n');
    const t = sessionMessagesToTranscript([tool('bash', content, { input: { command: 'npm test' } })]);
    const plain = stripAnsi(t);
    expect(plain).toContain('✓');
    expect(plain).toContain('bash');
    expect(plain).toContain('(npm test)');
    expect(plain).toContain('第1行');
    expect(plain).toContain('第10行'); // 防假绿：尾部行在 → 未裁剪
  });

  it('tool 错误 → ✗ 标记', () => {
    const t = sessionMessagesToTranscript([tool('bash', 'boom', { isError: true })]);
    const plain = stripAnsi(t);
    expect(plain).toContain('✗');
    expect(plain).toContain('bash');
  });

  it('tool 无 input → 无空括号', () => {
    const t = sessionMessagesToTranscript([tool('read_file', 'file contents')]);
    const plain = stripAnsi(t);
    expect(plain).toContain('read_file');
    expect(plain).not.toContain('()'); // summarizeArg 无 input 返回 ''，不应有空括号
  });

  it('tool 空 content → 只有标题行，无内容行', () => {
    const t = sessionMessagesToTranscript([tool('read_file', '')]);
    const plain = stripAnsi(t).trim();
    // 只有标题一行，不应有内容行
    expect(plain.split('\n')).toHaveLength(1);
    expect(plain).toContain('read_file');
  });

  it('warning 消息 → ▲ + 文本', () => {
    const t = sessionMessagesToTranscript([{ kind: 'warning', id: 'w1', text: '注意' }]);
    expect(stripAnsi(t)).toContain('▲ 注意');
  });

  it('error 消息 → ✗ + 文本', () => {
    const t = sessionMessagesToTranscript([{ kind: 'error', id: 'e1', text: '出错了' }]);
    expect(stripAnsi(t)).toContain('✗ 出错了');
  });

  it('ANSI 着色：含 24-bit 前景色转义（brand 色）', () => {
    const t = sessionMessagesToTranscript([assistant('hi')]);
    // T.brand = #4ECDC4 → \x1b[38;2;78;205;196m
    expect(t).toContain('\x1b[38;2;78;205;196m');
  });

  it('多消息 → 段间空行分隔', () => {
    const t = sessionMessagesToTranscript([user('a'), assistant('b')]);
    expect(t).toContain('\n\n');
    const plain = stripAnsi(t);
    expect(plain).toContain('❯ 你');
    expect(plain).toContain('◆ ECode');
  });
});
