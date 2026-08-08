// 5d：doom_loop 检测（spec M4 阶段5d，仿 opencode session/processor.ts:356-380）。
// 连续「同工具 + 相同输入」达到阈值即判定死循环嫌疑，强制权限询问让用户 continue/abort。
import { describe, it, expect } from 'vitest';
import { DoomLoopDetector, DOOM_LOOP_THRESHOLD, isDoomLoop } from '../../src/permission/doom-loop.js';

describe('DoomLoopDetector', () => {
  it('阈值 = 3（连续 3 次相同调用才触发）', () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
  });

  it('首次调用 count=1，不触发', () => {
    const d = new DoomLoopDetector();
    expect(d.observe('bash', { command: 'ls' })).toBe(1);
    expect(isDoomLoop(d.observe('bash', { command: 'ls' }))).toBe(false); // count=2
  });

  it('连续 3 次相同 → count=3，触发 doom', () => {
    const d = new DoomLoopDetector();
    d.observe('edit_file', { path: '/a' });
    d.observe('edit_file', { path: '/a' });
    expect(d.observe('edit_file', { path: '/a' })).toBe(3);
    expect(isDoomLoop(3)).toBe(true);
  });

  it('不同输入 → 计数重置（新 key 计 1）', () => {
    const d = new DoomLoopDetector();
    d.observe('bash', { command: 'ls' });
    d.observe('bash', { command: 'ls' });
    expect(d.observe('bash', { command: 'pwd' })).toBe(1); // 输入变了，重新计
  });

  it('不同工具（同输入）→ 计数重置', () => {
    const d = new DoomLoopDetector();
    d.observe('read_file', { path: '/a' });
    d.observe('read_file', { path: '/a' });
    expect(d.observe('edit_file', { path: '/a' })).toBe(1); // 工具变了
  });

  it('触发后再次相同 → count 继续递增（持续 doom，用户须主动 abort 打破）', () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < 3; i++) d.observe('bash', { command: 'x' });
    expect(d.observe('bash', { command: 'x' })).toBe(4);
    expect(isDoomLoop(4)).toBe(true);
  });

  it('输入对象键顺序不同但内容相同 → 仍算同一调用（稳定序列化）', () => {
    const d = new DoomLoopDetector();
    d.observe('bash', { a: 1, b: 2 });
    d.observe('bash', { b: 2, a: 1 }); // 同内容不同键序
    expect(d.observe('bash', { a: 1, b: 2 })).toBe(3); // 视为连续 3 次
  });

  it('reset → 清空计数', () => {
    const d = new DoomLoopDetector();
    d.observe('bash', { command: 'x' });
    d.observe('bash', { command: 'x' });
    d.reset();
    expect(d.observe('bash', { command: 'x' })).toBe(1);
  });

  it('交替两种调用 → 都不达阈值（A B A B A = 各 3 次但非连续）', () => {
    const d = new DoomLoopDetector();
    d.observe('bash', { command: 'a' });
    d.observe('bash', { command: 'b' });
    d.observe('bash', { command: 'a' });
    d.observe('bash', { command: 'b' });
    expect(d.observe('bash', { command: 'a' })).toBe(1); // 上一次是 b，a 重新计
  });
});
