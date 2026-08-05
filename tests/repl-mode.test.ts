// selectEntryMode 纯逻辑单测（spec §八 阶段②验收）。
// 覆盖 4 条决策路径 + 边界（--repl 与任务并存、TTY 与任务并存）。
import { describe, it, expect } from 'vitest';
import { selectEntryMode } from '../src/repl-mode.js';

describe('selectEntryMode', () => {
  it('--repl 标志强制 REPL（即便非 TTY、无任务）', () => {
    expect(selectEntryMode({ replFlag: true, hasTask: false, isTTY: false })).toBe('repl');
  });

  it('--repl 标志强制 REPL（即便有任务：任务被忽略，进 REPL）', () => {
    expect(selectEntryMode({ replFlag: true, hasTask: true, isTTY: true })).toBe('repl');
  });

  it('有任务 + 无 --repl → one-shot（保留 ecode "任务" 现状）', () => {
    expect(selectEntryMode({ replFlag: false, hasTask: true, isTTY: true })).toBe('oneshot');
    expect(selectEntryMode({ replFlag: false, hasTask: true, isTTY: false })).toBe('oneshot');
  });

  it('无任务 + TTY + 无 --repl → REPL（沉浸式默认入口）', () => {
    expect(selectEntryMode({ replFlag: false, hasTask: false, isTTY: true })).toBe('repl');
  });

  it('无任务 + 非 TTY + 无 --repl → usage（管道/CI 打印用法退出）', () => {
    expect(selectEntryMode({ replFlag: false, hasTask: false, isTTY: false })).toBe('usage');
  });

  it('--repl 优先级最高：覆盖 TTY 与任务状态的所有组合', () => {
    // 4 种 (hasTask, isTTY) 组合下，replFlag=true 一律 repl
    for (const hasTask of [true, false]) {
      for (const isTTY of [true, false]) {
        expect(selectEntryMode({ replFlag: true, hasTask, isTTY })).toBe('repl');
      }
    }
  });
});
