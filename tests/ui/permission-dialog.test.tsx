import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { PermissionDialog } from '../../src/ui/permission-dialog.js';
import type { PendingPermission } from '../../src/ui/types.js';

// 环境说明（React 19 + ink 7 + vitest 2 三点适配，同 spinner.test.tsx）：
// 1. ink 把 setTimeout 回调里的 setState 异步批处理，单次同步 advance 不会冲刷重渲染，
//    必须用 advanceTimersByTimeAsync；ink 的 commit 还比 timer 慢一个微任务批次，
//    故每次推进后再补一次 0ms 推进把渲染提交出来（grace period 的 setArmed 依赖此）。
// 2. stdin.write 经 ink-testing-library 同步触发 'readable' → handleReadable：
//    完整序列（\r / [B）当场 emit；但裸 ESC（）被 input-parser 判为 pending，
//    需推进 20ms（ink 的 escape flush 定时器）才 emit（见 ink App.schedulePendingInputFlush）。
// 3. useInput 的按键分发走 reconciler.discreteUpdates（离散事件，同步提交），
//    故 ↓/Enter 的 setSelected/onResolve 在 write 返回时已生效。

const PERM: PendingPermission = {
  toolUseId: 't1',
  toolName: 'bash',
  input: { command: 'rm -rf node_modules' },
};

describe('<PermissionDialog />', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('显示工具名 + 命令文本 + 三选项', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(<PermissionDialog permission={PERM} onResolve={onResolve} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Permission Required');
    expect(f).toContain('bash');
    expect(f).toContain('rm -rf node_modules');
    expect(f).toContain('Yes');
    expect(f).toContain("don't ask again");
    expect(f).toContain('No');
  });

  it('默认选中第 1 项（Yes），❯ 指示', () => {
    const { lastFrame } = render(<PermissionDialog permission={PERM} onResolve={vi.fn()} />);
    expect(lastFrame()).toContain('❯');
  });

  it('grace period：挂载后 425ms 内按 Enter 不触发 onResolve', () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM} onResolve={onResolve} />);
    stdin.write('\r'); // Enter —— 挂载瞬间 armed=false，grace 内忽略
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('grace period 过后（>425ms）按 Enter → onResolve(allow)（默认选 Yes）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM} onResolve={onResolve} />);
    await vi.advanceTimersByTimeAsync(500); // 触发 425ms grace 定时器 → setArmed(true) 入队
    await vi.advanceTimersByTimeAsync(0); // 冲刷 ink 渲染提交（armed 落地）
    stdin.write('\r'); // Enter
    expect(onResolve).toHaveBeenCalledWith('allow');
  });

  it('↓ 选中第 2 项后 Enter → allow_always', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM} onResolve={onResolve} />);
    await vi.advanceTimersByTimeAsync(500); // arm
    await vi.advanceTimersByTimeAsync(0); // commit
    stdin.write('[B'); // ↓ —— 完整序列当场 emit
    await vi.advanceTimersByTimeAsync(0); // 确保 setSelected(1) 提交
    stdin.write('\r'); // Enter
    expect(onResolve).toHaveBeenCalledWith('allow_always');
  });

  it('Esc → onResolve(deny)', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PermissionDialog permission={PERM} onResolve={onResolve} />);
    await vi.advanceTimersByTimeAsync(500); // arm
    await vi.advanceTimersByTimeAsync(0); // commit
    stdin.write(''); // Esc —— 裸 ESC 被 input-parser 判为 pending
    await vi.advanceTimersByTimeAsync(20); // 触发 ink 的 20ms escape flush → emit ESC
    expect(onResolve).toHaveBeenCalledWith('deny');
  });
});
