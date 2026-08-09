// InputBar 测试（spec §5.3 / §8.4 / 多行输入详设 docs/详设/20260808150000）。
// 键盘测试要点（同 permission-dialog.test.tsx 的 Task 7 经验，React 19 + ink 7 + vitest 2）：
// 1. ink 把 useInput 回调里的 setState 经 setTimeout 节流异步提交，stdin.write 返回时
//    lastFrame() 读到的还是旧帧。必须用 fake timers + advanceTimersByTimeAsync(0)
//    把渲染提交冲刷出来（permission-dialog 已验证此组合）。
// 2. useInput 内部用 useEffectEvent（React 19）包裹回调，始终拿到最新 state 闭包，
//    故连续 write(文本) → write(\r) 的提交链能读到上一轮已提交的 text。
// 3. ↑ 用完整 CSI 序列 '\x1b[A'（裸 '[A' 会被当普通字符追加到输入）；
//    Enter 用 '\r'（完整序列当场 emit，无需 escape flush）。
//
// 多行输入序列（详设 §2/§6）：
//   parseKeypress 是纯字节解析——测试直接 write 序列即可触发，**不依赖运行时是否启用
//   Kitty 协议**（ink-testing-library 的 stdin 经 ink 的 parseKeypress 管道）：
//   - Shift+Enter：'\x1b[13;2u'（Kitty CSI u，codepoint 13 + shift 修饰位 2）
//   - Alt+Enter ：'\x1b\r'（ESC+CR，非 Kitty 路径原生识别为 meta+return）
//   - ←         ：'\x1b[D'；backspace：'\x7f'
// 断言以 onSubmit 收到的文本为主（确定、不依赖 cursor 反白的 ANSI 渲染细节）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { InputBar } from '../../src/ui/input-bar.js';
import { SYMBOLS } from '../../src/ui/theme.js';

describe('<InputBar />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('显示 ❯ 提示符 + 当前输入', async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    stdin.write('hi');
    await vi.advanceTimersByTimeAsync(0); // 冲刷 ink 渲染提交
    expect(lastFrame()).toContain(SYMBOLS.user);
    expect(lastFrame()).toContain('hi');
  });

  it('Enter → onSubmit(当前文本) + 清空', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('hello');
    await vi.advanceTimersByTimeAsync(0); // text='hello' 落地
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0); // onSubmit + 清空落地
    expect(onSubmit).toHaveBeenCalledWith('hello');
    // 提交后输入框清空（不含 hello）
    expect(lastFrame()).not.toContain('hello');
  });

  it('空输入 Enter 不提交', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('历史：提交两次后 ↑ 调出上一条', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('first');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('second');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b[A'); // ↑ —— 完整 CSI 序列（ESC + [A）
    await vi.advanceTimersByTimeAsync(0); // 历史定位落地
    expect(lastFrame()).toContain('second');
  });

  // --- 多行输入（详设 docs/详设/20260808150000）---

  it('Shift+Enter(\\x1b[13;2u) 插换行 + 多行整段提交', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('line1');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b[13;2u'); // Shift+Enter（Kitty CSI u）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('line2');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r'); // 裸 Enter 提交
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
  });

  it('Alt+Enter(\\x1b\\r) 插换行', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('foo');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b\r'); // Alt+Enter（ESC+CR）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('bar');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).toHaveBeenCalledWith('foo\nbar');
  });

  it('反斜杠续行：行尾 \\ + Enter 删 \\ 插换行（全平台兜底）', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('abc\\'); // abc\
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r'); // 续行（行尾 \ + 裸 Enter）→ abc\n
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('def');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r'); // 提交
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).toHaveBeenCalledWith('abc\ndef');
  });

  it('← 移动光标后插入落在中间位置', async () => {
    const { stdin, lastFrame } = render(<InputBar onSubmit={vi.fn()} />);
    stdin.write('ab');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b[D'); // ← → cursorIndex 1
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('X'); // 在 cursor=1 插入 → aXb（cursor 落在 b，反白）
    await vi.advanceTimersByTimeAsync(0);
    // cursor 反白格把 b 用 ANSI 包裹，'aXb' 被打断不连续；断 'aX'（cursor 前段，单个 Text 内连续），
    // X 紧跟 a 即证明插入落在中间而非末尾 'abX'。
    expect(lastFrame()).toContain('aX');
  });

  it('Backspace 跨行合并：行首删 \\n', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    stdin.write('ab');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b[13;2u'); // 换行 → ab\n（cursor 在新行首）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x7f'); // backspace 删 \n → ab（cursor 回到 b 后）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('cd'); // ab + cd = abcd
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).toHaveBeenCalledWith('abcd');
  });

  it('↑ 门控：多行中间行不翻历史，到首行才翻', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onSubmit={onSubmit} />);
    // 造一条历史
    stdin.write('hist');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    // 多行输入 a\nb（cursor 落在末行 b）
    stdin.write('a');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\x1b[13;2u');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('b');
    await vi.advanceTimersByTimeAsync(0);
    // 第一次 ↑：末行→上移光标到首行（门控：不翻历史），草稿仍是 a\nb
    stdin.write('\x1b[A');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain('a');
    expect(lastFrame()).toContain('b');
    // 第二次 ↑：已在首行→翻历史调出 hist
    stdin.write('\x1b[A');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain('hist');
  });

  // --- 中断撤回回填（draftText + draftVersion，controlled prop 替代 ref）---

  it('draftVersion 递增 → 回填 draftText 到输入框', async () => {
    const { lastFrame, rerender } = render(<InputBar onSubmit={vi.fn()} />);
    // 初版无回填信号，输入框空白
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).not.toContain('被中断的内容');
    // 中断撤回：递增 version → useEffect 回填
    rerender(<InputBar onSubmit={vi.fn()} draftText="被中断的内容" draftVersion={1} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain('被中断的内容');
  });

  it('回填后是草稿态可继续编辑（回填不锁定，cursor 落末尾）', async () => {
    const onSubmit = vi.fn();
    const { stdin, rerender } = render(<InputBar onSubmit={onSubmit} />);
    rerender(<InputBar onSubmit={onSubmit} draftText="撤回的文本" draftVersion={1} />);
    await vi.advanceTimersByTimeAsync(0);
    // 继续输入 + 提交（证明回填后输入框可编辑，且追加在末尾）
    stdin.write('追');
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('\r');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubmit).toHaveBeenCalledWith('撤回的文本追');
  });

  it('相同 draftVersion 不重复回填（版本号防抖）', async () => {
    const { lastFrame, rerender } = render(<InputBar onSubmit={vi.fn()} />);
    rerender(<InputBar onSubmit={vi.fn()} draftText="A" draftVersion={1} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain('A');
    // 同 version 再 render（draftText 变了但 version 没递增）→ 不回填
    rerender(<InputBar onSubmit={vi.fn()} draftText="B" draftVersion={1} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFrame()).toContain('A');
    expect(lastFrame()).not.toContain('B');
  });
});
