// formatRelativeTimeAgo 单测：会话列表 metadata 相对时间（/resume picker 用）。
// 纯函数，now 显式传入（不依赖 Date.now()，可确定断言）。
import { describe, it, expect } from 'vitest';
import { formatRelativeTimeAgo } from '../../src/ui/format-time.js';

// 固定 now（new Date(isoString).getTime() 允许；脚本只禁 argless new Date()）
const NOW = new Date('2026-08-06T12:00:00.000Z').getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();

describe('formatRelativeTimeAgo', () => {
  it('30s 前 → 刚刚', () => {
    expect(formatRelativeTimeAgo(isoAgo(30_000), NOW)).toBe('刚刚');
  });

  it('59s 前 → 刚刚（临界 <1min）', () => {
    expect(formatRelativeTimeAgo(isoAgo(59_000), NOW)).toBe('刚刚');
  });

  it('5min 前 → 5分钟前', () => {
    expect(formatRelativeTimeAgo(isoAgo(5 * MIN), NOW)).toBe('5分钟前');
  });

  it('59min 前 → 59分钟前（临界 <1h）', () => {
    expect(formatRelativeTimeAgo(isoAgo(59 * MIN), NOW)).toBe('59分钟前');
  });

  it('2h 前 → 2小时前', () => {
    expect(formatRelativeTimeAgo(isoAgo(2 * HOUR), NOW)).toBe('2小时前');
  });

  it('23h 前 → 23小时前（临界 <24h）', () => {
    expect(formatRelativeTimeAgo(isoAgo(23 * HOUR), NOW)).toBe('23小时前');
  });

  it('25h 前 → 1天前', () => {
    expect(formatRelativeTimeAgo(isoAgo(25 * HOUR), NOW)).toBe('1天前');
  });

  it('48h 前 → 2天前', () => {
    expect(formatRelativeTimeAgo(isoAgo(2 * DAY), NOW)).toBe('2天前');
  });

  it('未来时间（clock skew）→ 刚刚（不报错、不产负数）', () => {
    expect(formatRelativeTimeAgo(isoAgo(-10_000), NOW)).toBe('刚刚');
  });
});
