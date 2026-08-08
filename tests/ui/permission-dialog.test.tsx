import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { PermissionDialog } from '../../src/ui/permission-dialog.js';
import type { PendingPermission } from '../../src/ui/types.js';

// 环境说明（React 19 + ink 7 + vitest 2 三点适配，同 spinner.test.tsx）：
// 1. ink 把 setTimeout 回调里的 setState 异步批处理，单次同步 advance 不会冲刷重渲染，
//    必须用 advanceTimersByTimeAsync；ink 的 commit 还比 timer 慢一个微任务批次，
//    故每次推进后再补一次 0ms 推进把渲染提交出来（grace period 的 setArmed 依赖此）。
// 2. stdin.write 经 ink-testing-library 同步触发 'readable' → handleReadable：
//    完整序列（\r / \x1b[B）当场 emit；但裸 ESC（\x1b）被 input-parser 判为 pending，
//    需推进 20ms（ink 的 escape flush 定时器）才 emit（见 ink App.schedulePendingInputFlush）。
// 3. useInput 的按键分发走 reconciler.discreteUpdates（离散事件，同步提交），
//    故 ↓/Enter 的 setSelected/onResolve 在 write 返回时已生效。
// 注：下方向键显式写 '\x1b[B'（ESC + [B），避免依赖不可见裸 ESC 字节。

const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';

const PERM_DANGER: PendingPermission = {
  toolUseId: 't1',
  toolName: 'bash',
  input: { command: 'rm -rf node_modules' },
};
const PERM_SAFE: PendingPermission = {
  toolUseId: 't2',
  toolName: 'bash',
  input: { command: 'git status' },
};

/** arm（grace 过）后冲刷渲染，供后续按键立即可用。 */
async function arm(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500); // 触发 425ms grace 定时器 → setArmed(true) 入队
  await vi.advanceTimersByTimeAsync(0); // 冲刷 ink 渲染提交（armed 落地）
}

describe('<PermissionDialog />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('显示工具名 + 命令文本 + 三选项', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Permission Required');
    expect(f).toContain('bash');
    expect(f).toContain('rm -rf node_modules');
    expect(f).toContain('Yes');
    expect(f).toContain("don't ask again");
    expect(f).toContain('No');
  });

  it('默认选中第 1 项（Yes），❯ 指示', () => {
    const { lastFrame } = render(<PermissionDialog permission={PERM_DANGER} onResolve={vi.fn()} />);
    expect(lastFrame()).toContain('❯');
  });

  it('grace period：挂载后 425ms 内按 Enter 不触发 onResolve', () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    stdin.write(ENTER); // 挂载瞬间 armed=false，grace 内忽略
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('grace period 过后（>425ms）按 Enter → onResolve(allow)（默认选 Yes，allow 无需二次确认）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    await arm();
    stdin.write(ENTER);
    expect(onResolve).toHaveBeenCalledWith('allow');
  });

  // ── 5a：allow_always 二次确认 ──
  it('5a：↓ 选 allow_always + Enter → 进确认面板（不直接 resolve），再 Enter 才放行', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    await arm();
    stdin.write(DOWN); // ↓ 选 allow_always（index 1）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 进 confirm-always，尚未 resolve
    expect(onResolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    // 确认面板展示将放行的 pattern（rm -rf node_modules 归约成 'rm *'）+ 提示语
    const f = lastFrame() ?? '';
    expect(f).toContain('匹配模式');
    expect(f).toContain('rm *');
    stdin.write(ENTER); // 再 Enter 确认
    expect(onResolve).toHaveBeenCalledWith('allow_always');
  });

  it('5a：确认面板按 n 返回选择（不 resolve）', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    await arm();
    stdin.write(DOWN); // allow_always
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 进确认面板
    await vi.advanceTimersByTimeAsync(0);
    stdin.write('n'); // 返回
    await vi.advanceTimersByTimeAsync(0);
    expect(onResolve).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain("don't ask again"); // 回到选择态
  });

  // ── 5b：reject 反馈框 ──
  it('5b：选 deny + Enter → 进反馈框；输入反馈 + Enter → onResolve(deny, feedback)', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM_SAFE} onResolve={onResolve} />);
    await arm();
    stdin.write(DOWN);
    stdin.write(DOWN); // ↓↓ 选 deny（index 2）
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 进反馈框
    await vi.advanceTimersByTimeAsync(0);
    expect(onResolve).not.toHaveBeenCalled();
    stdin.write('stop'); // 输入反馈
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 提交
    expect(onResolve).toHaveBeenCalledWith('deny', 'stop');
  });

  it('5b：反馈框留空 + Enter → onResolve(deny)（无 feedback，直接拒绝）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM_SAFE} onResolve={onResolve} />);
    await arm();
    stdin.write(DOWN);
    stdin.write(DOWN); // deny
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 进反馈框
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 留空直接提交
    expect(onResolve).toHaveBeenCalledWith('deny'); // 无第二参数
  });

  it('5b：反馈框 esc 返回选择（不 resolve）', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = render(<PermissionDialog permission={PERM_SAFE} onResolve={onResolve} />);
    await arm();
    stdin.write(DOWN);
    stdin.write(DOWN); // deny
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ENTER); // 进反馈框
    await vi.advanceTimersByTimeAsync(0);
    stdin.write(ESC); // 裸 ESC —— input-parser pending，需 20ms flush
    await vi.advanceTimersByTimeAsync(20);
    expect(onResolve).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain("don't ask again"); // 回到选择态
  });

  // ── choose 态 Esc 快速 deny（保留旧行为）──
  it('Esc → onResolve(deny)（choose 态快速拒绝，无反馈）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM_DANGER} onResolve={onResolve} />);
    await arm();
    stdin.write(ESC); // 裸 ESC
    await vi.advanceTimersByTimeAsync(20); // escape flush
    expect(onResolve).toHaveBeenCalledWith('deny');
  });

  // ── 5c：危险命令高亮 ──
  it('5c：rm -rf 命令显示危险高亮警告', () => {
    const { lastFrame } = render(<PermissionDialog permission={PERM_DANGER} onResolve={vi.fn()} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('递归强删');
  });

  it('5c：安全命令（git status）不显示危险警告', () => {
    const { lastFrame } = render(<PermissionDialog permission={PERM_SAFE} onResolve={vi.fn()} />);
    const f = lastFrame() ?? '';
    expect(f).not.toContain('递归强删');
    expect(f).not.toContain('强制推送');
  });

  // ── 5d：doom_loop reason 醒目提示 ──
  it('5d：permission.reason 存在 → 顶部显示醒目提示', () => {
    const perm: PendingPermission = {
      toolUseId: 't3',
      toolName: 'read_file',
      input: { path: '/a' },
      reason: '疑似死循环（连续 3 次相同调用），确认继续？',
    };
    const { lastFrame } = render(<PermissionDialog permission={perm} onResolve={vi.fn()} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('疑似死循环');
  });
});
