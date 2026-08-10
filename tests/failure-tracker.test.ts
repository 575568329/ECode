// failure-tracker.ts —— 公共工具连续失败追踪器测试
import { describe, it, expect } from 'vitest';
import { ToolFailureTracker } from '../src/tools/failure-tracker.js';

describe('ToolFailureTracker', () => {
  it('连续失败 < 阈值 → 不触发', () => {
    const tracker = new ToolFailureTracker(3);
    const r1 = tracker.observe('bash', true, 'error-1');
    const r2 = tracker.observe('bash', true, 'error-2');
    expect(r1.triggered).toBe(false);
    expect(r2.triggered).toBe(false);
    expect(r2.streak).toBe(2);
  });

  it('连续失败 = 阈值 → 首次触发', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'err1');
    tracker.observe('bash', true, 'err2');
    const r3 = tracker.observe('bash', true, 'err3');
    expect(r3.triggered).toBe(true);
    expect(r3.streak).toBe(3);
    expect(r3.message).toContain('bash');
    expect(r3.message).toContain('3 次');
    expect(r3.message).toContain('err3');
    expect(r3.message).toContain('换一种策略');
  });

  it('触发后继续失败不重复触发（同阈值）', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    const r3 = tracker.observe('bash', true, 'e3');
    expect(r3.triggered).toBe(true); // streak=3 首次触发
    const r4 = tracker.observe('bash', true, 'e4');
    expect(r4.triggered).toBe(false); // streak=4 不重复
    const r5 = tracker.observe('bash', true, 'e5');
    expect(r5.triggered).toBe(false); // streak=5 不重复
  });

  it('触发后翻倍时再触发一次（第二次提醒）', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    const r3 = tracker.observe('bash', true, 'e3');
    expect(r3.triggered).toBe(true); // streak=3
    tracker.observe('bash', true, 'e4');
    tracker.observe('bash', true, 'e5');
    const r6 = tracker.observe('bash', true, 'e6');
    expect(r6.triggered).toBe(true); // streak=6 = 3*2，翻倍再触发
  });

  it('成功一次即归零', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    tracker.observe('bash', false); // 成功，归零
    const r = tracker.observe('bash', true, 'e3');
    expect(r.triggered).toBe(false);
    expect(r.streak).toBe(1);
  });

  it('归零后重新达到阈值 → 再次触发', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    tracker.observe('bash', true, 'e3'); // triggered
    tracker.observe('bash', false); // 成功归零
    tracker.observe('bash', true, 'e4');
    tracker.observe('bash', true, 'e5');
    const r3 = tracker.observe('bash', true, 'e6');
    expect(r3.triggered).toBe(true); // 重新从 0 计 3 次
  });

  it('不同工具独立计数（互不干扰）', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    tracker.observe('grep', true, 'g1');
    tracker.observe('grep', true, 'g2');
    tracker.observe('grep', true, 'g3');
    // bash streak=2（未触发），grep streak=3（触发）
    expect(tracker.getStreak('bash')).toBe(2);
    expect(tracker.getStreak('grep')).toBe(3);
  });

  it('成功时传 errorContent 不影响归零', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    const r = tracker.observe('bash', false, 'ignored');
    expect(r.triggered).toBe(false);
    expect(r.streak).toBe(0);
    expect(tracker.getStreak('bash')).toBe(0);
  });

  it('默认阈值 = 3', () => {
    const tracker = new ToolFailureTracker();
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    const r3 = tracker.observe('bash', true, 'e3');
    expect(r3.triggered).toBe(true);
  });

  it('阈值 = 2：更激进', () => {
    const tracker = new ToolFailureTracker(2);
    tracker.observe('bash', true, 'e1');
    const r2 = tracker.observe('bash', true, 'e2');
    expect(r2.triggered).toBe(true);
  });

  it('错误内容截断 200 字符（防超长错误撑爆提醒文本）', () => {
    const tracker = new ToolFailureTracker(3);
    const longError = 'x'.repeat(500);
    tracker.observe('bash', true, longError);
    tracker.observe('bash', true, longError);
    const r3 = tracker.observe('bash', true, longError);
    expect(r3.triggered).toBe(true);
    // message 含截断后的错误（≤200 字符 + 前缀文本）
    const errorPart = r3.message.split('最近错误：')[1]?.split('\n')[0];
    expect(errorPart!.length).toBeLessThanOrEqual(200);
  });

  it('reset 清空所有记录', () => {
    const tracker = new ToolFailureTracker(3);
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    tracker.reset();
    expect(tracker.getStreak('bash')).toBe(0);
    // reset 后重新计 3 次才触发
    tracker.observe('bash', true, 'e1');
    tracker.observe('bash', true, 'e2');
    const r3 = tracker.observe('bash', true, 'e3');
    expect(r3.triggered).toBe(true);
  });

  it('MCP 工具名也能正常追踪', () => {
    const tracker = new ToolFailureTracker(3);
    const mcpName = 'mcp__zread__read_file';
    tracker.observe(mcpName, true, 'timeout');
    tracker.observe(mcpName, true, 'timeout');
    const r3 = tracker.observe(mcpName, true, 'timeout');
    expect(r3.triggered).toBe(true);
    expect(r3.message).toContain(mcpName);
  });
});
