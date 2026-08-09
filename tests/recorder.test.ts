import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// recorder：记录层核心。纯函数（matchSignal/buildObservation/isDuplicate/trimFifo）+ IO 整合（recordObservation）。
// 纯函数直测；recordObservation 用临时目录端到端测（对齐 grep.test.ts 风格）。
import {
  matchSignal,
  buildObservation,
  isDuplicate,
  trimFifo,
  recordObservation,
} from '../src/skill-capture/recorder.js';
import type { Observation } from '../src/skill-capture/recorder.js';
import type { SkillCaptureConfig } from '../src/skill-capture/config.js';

function cfg(over: Partial<SkillCaptureConfig> = {}): SkillCaptureConfig {
  return { enabled: true, patterns: [], maxBytes: 1_048_576, maxObservations: 1000, ...over };
}

// ---- 纯函数 ----

describe('matchSignal', () => {
  it('内置 correction 命中（下次/以后/记住…）', () => {
    expect(matchSignal('下次记得跑测试', [])).toEqual({ signal: 'correction' });
  });
  it('内置 preference 命中（prefer/我喜欢…）', () => {
    expect(matchSignal('prefer 用 fs.promises', [])).toEqual({ signal: 'preference' });
  });
  it('用户自定义 pattern 命中 → custom', () => {
    expect(matchSignal('我们的规范是函数都要注释', ['我们的规范'])).toEqual({ signal: 'custom' });
  });
  it('都不命中 → null（不记）', () => {
    expect(matchSignal('今天天气不错', [])).toBeNull();
  });
  it('用户正则非法 → 跳过不抛（其余 pattern 仍生效）', () => {
    expect(matchSignal('命中关键词', ['(', '命中关键词'])).toEqual({ signal: 'custom' });
  });
});

describe('buildObservation', () => {
  it('content 经 redact 脱敏（密钥变 [REDACTED]）', () => {
    const o = buildObservation('下次别提交 token=secret123', 'correction', { session: 's1' }, new Date('2026-08-09T10:00:00Z'));
    expect(o.signal).toBe('correction');
    expect(o.source).toBe('UserPromptSubmit');
    expect(o.content).toContain('[REDACTED]');
    expect(o.content).not.toContain('secret123');
    expect(o.ts).toBe('2026-08-09T10:00:00.000Z');
  });
  it('超长 content 截断到 500 字符', () => {
    const long = '下次' + 'x'.repeat(600);
    const o = buildObservation(long, 'correction', { session: 's1' }, new Date());
    expect(o.content.length).toBe(500);
  });
  it('context.file 存在时写入 context', () => {
    const o = buildObservation('下次记住', 'correction', { session: 's1', file: 'src/agent.ts' }, new Date());
    expect(o.context).toEqual({ file: 'src/agent.ts' });
  });
  it('无 file 时 context 为 undefined', () => {
    const o = buildObservation('下次记住', 'correction', { session: 's1' }, new Date());
    expect(o.context).toBeUndefined();
  });
});

describe('isDuplicate', () => {
  const now = new Date('2026-08-09T10:00:00Z');
  it('同 content 24h 内 → 重复', () => {
    const recent: Observation[] = [{ ts: '2026-08-09T09:30:00.000Z', signal: 'correction', source: 'UserPromptSubmit', content: '下次记得', session: 's1' }];
    expect(isDuplicate(recent, '下次记得', now)).toBe(true);
  });
  it('同 content 超 24h → 不重复', () => {
    const recent: Observation[] = [{ ts: '2026-08-08T09:00:00.000Z', signal: 'correction', source: 'UserPromptSubmit', content: '下次记得', session: 's1' }];
    expect(isDuplicate(recent, '下次记得', now)).toBe(false);
  });
  it('不同 content → 不重复', () => {
    const recent: Observation[] = [{ ts: '2026-08-09T09:30:00.000Z', signal: 'correction', source: 'UserPromptSubmit', content: '下次记得', session: 's1' }];
    expect(isDuplicate(recent, '下次别忘', now)).toBe(false);
  });
});

describe('trimFifo', () => {
  const mk = (i: number): Observation => ({ ts: `2026-08-09T10:0${i}:00.000Z`, signal: 'correction', source: 'UserPromptSubmit', content: `下次记录${i}`, session: 's1' });
  it('超 maxObservations → 删最老（头部）', () => {
    const records = [mk(0), mk(1), mk(2), mk(3)];
    const out = trimFifo(records, 2, 1_048_576);
    expect(out.length).toBe(2);
    expect(out[0].content).toBe('下次记录2'); // 最老的 0、1 被删
    expect(out[1].content).toBe('下次记录3');
  });
  it('超 maxBytes → 删最老直到字节满足（至少留最新一条）', () => {
    const records = [mk(0), mk(1), mk(2)];
    const out = trimFifo(records, 1000, 140); // 单条约 ~131B ≤ 140，两条 > 140 → 删到剩最新 1 条
    const totalBytes = out.reduce((s, o) => s + Buffer.byteLength(JSON.stringify(o) + '\n', 'utf-8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(140);
    expect(out.length).toBeLessThan(records.length);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].content).toBe('下次记录2'); // 留最新
  });
  it('未超限 → 原样返回', () => {
    const records = [mk(0), mk(1)];
    expect(trimFifo(records, 1000, 1_048_576)).toEqual(records);
  });
});

// ---- IO 整合（临时目录端到端）----

describe('recordObservation (IO)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = join(tmpdir(), `ecode-recorder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    file = join(dir, 'observations.jsonl');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('enabled=false 时不记录（文件不创建）', () => {
    recordObservation('下次记得跑测试', { session: 's1' }, cfg({ enabled: false }), { file });
    expect(existsSync(file)).toBe(false);
  });

  it('不命中正则时不记录', () => {
    recordObservation('今天天气不错', { session: 's1' }, cfg(), { file });
    expect(existsSync(file)).toBe(false);
  });

  it('命中内置 correction → 记一条（content 已脱敏）', () => {
    recordObservation('下次别提交 token=secret123', { session: 's1' }, cfg(), { file });
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const o = JSON.parse(lines[0]);
    expect(o.signal).toBe('correction');
    expect(o.content).toContain('[REDACTED]');
    expect(o.content).not.toContain('secret123');
  });

  it('同 content 24h 内 → 去重不记', () => {
    const t0 = new Date('2026-08-09T10:00:00Z');
    recordObservation('下次记得', { session: 's1' }, cfg(), { file, now: () => t0 });
    recordObservation('下次记得', { session: 's1' }, cfg(), { file, now: () => new Date(t0.getTime() + 60_000) });
    expect(readFileSync(file, 'utf-8').trim().split('\n').length).toBe(1);
  });

  it('同 content 超 24h → 再记一条', () => {
    const t0 = new Date('2026-08-09T10:00:00Z');
    recordObservation('下次记得', { session: 's1' }, cfg(), { file, now: () => t0 });
    recordObservation('下次记得', { session: 's1' }, cfg(), { file, now: () => new Date(t0.getTime() + 25 * 3_600_000) });
    expect(readFileSync(file, 'utf-8').trim().split('\n').length).toBe(2);
  });

  it('超 maxObservations → FIFO 删最老', () => {
    const c = cfg({ maxObservations: 2 });
    const base = new Date('2026-08-09T10:00:00Z');
    recordObservation('下次记得甲', { session: 's1' }, c, { file, now: () => base });
    recordObservation('下次记得乙', { session: 's1' }, c, { file, now: () => new Date(base.getTime() + 200_000) });
    recordObservation('下次记得丙', { session: 's1' }, c, { file, now: () => new Date(base.getTime() + 400_000) });
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const last = JSON.parse(lines[1]);
    expect(last.content).toContain('丙'); // 最老的「甲」被删，留 [乙, 丙]
  });

  it('用户自定义 pattern 命中 → 记 custom', () => {
    recordObservation('我们的规范是函数都要注释', { session: 's1' }, cfg({ patterns: ['我们的规范'] }), { file });
    const o = JSON.parse(readFileSync(file, 'utf-8').trim());
    expect(o.signal).toBe('custom');
  });
});
