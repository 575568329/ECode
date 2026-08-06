// 人肉驱动器：把 ink-testing-library 的 stdin.write + fake-timer 冲刷包成「人操作」API。
// 目的：测试写成「打字 → 看实际渲染 → 据反馈判断下一步」，而非预先硬编码断言。
//
// 时序依据（沿用 input-bar / permission-dialog 测试踩坑，React 19 + ink 7 + vitest 2）：
//  - ink 把 useInput 回调里的 setState 经 setTimeout 节流：写完必须 advanceTimersByTimeAsync(0)
//    冲刷渲染提交，否则 lastFrame 读到旧帧。
//  - ↑↓ 用完整 CSI（ESC + [A / [B）；Enter 用 \r：完整序列当场 emit。
//  - 裸 ESC 被 ink input-parser 判 pending，需推进 20ms（escape flush 定时器）才 emit
//    （permission-dialog.test.tsx 已验证此 20ms）。
// 前提：调用方已 vi.useFakeTimers()。
import { render } from 'ink-testing-library';
import React from 'react';
import { vi } from 'vitest';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const ESC = '\x1b';

export interface Simulator {
  /** 人打字（整串写入；ink 自动按 keypress 拆，中文多字节也 OK） */
  type(text: string): Promise<void>;
  enter(): Promise<void>;
  up(): Promise<void>;
  down(): Promise<void>;
  /** Esc：内部推进 20ms 触发 ink 的 escape flush */
  esc(): Promise<void>;
  ctrlC(): Promise<void>;
  /** Ctrl+O（转录 pager 入口，方向 B）：写 \x0f，ink 解析为 input='o' + key.ctrl */
  ctrlO(): Promise<void>;
  backspace(): Promise<void>;
  /** 实际渲染帧（含 ANSI 颜色码） */
  frame(): string;
  /** 去 ANSI 的纯文本帧（断言用，避开颜色码干扰） */
  plain(): string;
  /** 人等「看到某反馈」：轮询推进 fake timer 直到谓词成立或超时。超时抛出末帧便于排查。 */
  waitFor(predicate: (plain: string) => boolean, opts?: { timeoutMs?: number }): Promise<void>;
  unmount(): void;
}

export function simulate(jsx: React.ReactElement): Simulator {
  const { stdin, lastFrame, unmount } = render(jsx);
  const flush0 = () => vi.advanceTimersByTimeAsync(0);
  const plain = () => (lastFrame() ?? '').replace(ANSI, '');
  return {
    type: async (t) => {
      stdin.write(t);
      await flush0();
    },
    enter: async () => {
      stdin.write('\r');
      await flush0();
    },
    up: async () => {
      stdin.write(`${ESC}[A`);
      await flush0();
    },
    down: async () => {
      stdin.write(`${ESC}[B`);
      await flush0();
    },
    // 裸 ESC 被 input-parser 判 pending，需 20ms escape flush（见文件头注释）
    esc: async () => {
      stdin.write(ESC);
      await vi.advanceTimersByTimeAsync(20);
    },
    ctrlC: async () => {
      stdin.write('\x03');
      await flush0();
    },
    ctrlO: async () => {
      stdin.write('\x0f');
      await flush0();
    },
    backspace: async () => {
      stdin.write('\x7f');
      await flush0();
    },
    frame: () => lastFrame() ?? '',
    plain,
    waitFor: async (predicate, opts) => {
      const timeoutMs = opts?.timeoutMs ?? 2000;
      for (let elapsed = 0; elapsed < timeoutMs; elapsed++) {
        if (predicate(plain())) return;
        await vi.advanceTimersByTimeAsync(1);
      }
      if (predicate(plain())) return;
      throw new Error(`simulate.waitFor 超时（${timeoutMs}ms）。末帧：\n${lastFrame() ?? ''}`);
    },
    unmount,
  };
}
