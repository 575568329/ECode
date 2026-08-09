// ============================================================
// 记录层核心（M6 阶段D 技能生成 · §3）—— UserPromptSubmit 时机回调
// ============================================================
//
// 为什么不走 M5 hook？M5 hook 是 spawn shell 处理器（runner.ts），handler 是 shell 脚本，
// 无法在 JS 直接 append JSONL（§17🔴1）。故在 agent.ts:373（UserPromptSubmit 事件已 emit）
// 直接调用本模块 recordObservation()：信号最精准（用户刚表达意图）、失败静默降级。
//
// 分层：纯函数（matchSignal/buildObservation/isDuplicate/trimFifo）可单测；
//      recordObservation 是 IO 整合（读全→push→trim→写全），用同步 fs（低频，单次 < 几 ms）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redactSecrets } from './redact.js';
import type { SkillCaptureConfig } from './config.js';

/** 记录上下文（调用方提供 session id + 可选关联文件）。 */
export interface ObservationContext {
  session: string;
  file?: string;
}

/** 一条观察记录（observations.jsonl 的单行，append-only）。 */
export interface Observation {
  /** ISO 时间（归纳时引用作证据）。 */
  ts: string;
  /** correction（修正）| preference（偏好）| custom（用户自定义正则命中）。 */
  signal: string;
  /** 来源标记（回调时机）。 */
  source: 'UserPromptSubmit';
  /** ≤500 字符，已 redact 脱敏（不落密钥/凭证，§9.2）。 */
  content: string;
  /** 可选：关联文件/工具。 */
  context?: { file?: string };
  /** session id，归纳时按会话聚合。 */
  session: string;
}

/** 内置正则（correction 修正行为 + preference 表达偏好；与用户 patterns 合并）。
 *  无 g 标志：避免 RegExp.test 的 lastIndex 跨调用累积陷阱。 */
const BUILTIN_PATTERNS: ReadonlyArray<{ signal: string; regex: RegExp }> = [
  { signal: 'correction', regex: /下次|以后|记住|总是|别再|always|remember|next time|don't/i },
  { signal: 'preference', regex: /我喜欢|prefer|默认用|用.{0,8}而不是/ },
];

const MAX_CONTENT_CHARS = 500;
/** O(N) 去重扫描窗口：只读文件末尾 N 条比对，不扫整个 1MB（§17🟡6）。 */
const DEDUP_WINDOW = 50;
/** 去重 TTL：同 content 24h 内不重复记。 */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/** 默认 observations.jsonl 路径（项目级 .ecode，与 sessions 同根，已 gitignore）。 */
function defaultObservationsPath(): string {
  return join(process.cwd(), '.ecode', 'observations.jsonl');
}

/** 匹配信号：内置 correction/preference 优先，再扫用户 patterns；首个命中返回 signal，都不中返回 null。 */
export function matchSignal(text: string, userPatterns: string[]): { signal: string } | null {
  for (const { signal, regex } of BUILTIN_PATTERNS) {
    if (regex.test(text)) return { signal };
  }
  for (const p of userPatterns) {
    try {
      if (new RegExp(p).test(text)) return { signal: 'custom' };
    } catch {
      // 用户正则非法：跳过该条（不阻塞其他 pattern 匹配，不抛）
    }
  }
  return null;
}

/** 截断 content 到最大字符数（超长尾部丢弃）。 */
export function truncateContent(text: string, max = MAX_CONTENT_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 构造一条观察记录：redact 脱敏 + 截断 + 时间戳 + 上下文。 */
export function buildObservation(
  text: string,
  signal: string,
  ctx: ObservationContext,
  now: Date,
): Observation {
  return {
    ts: now.toISOString(),
    signal,
    source: 'UserPromptSubmit',
    content: truncateContent(redactSecrets(text)),
    context: ctx.file ? { file: ctx.file } : undefined,
    session: ctx.session,
  };
}

/** 去重判定：recent（末尾窗口）内存在同 content 且 ts 在 24h 内 → 重复。
 *  从后往前扫（最近的最可能重复），ts 非法跳过。 */
export function isDuplicate(recent: Observation[], content: string, now: Date): boolean {
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r.content !== content) continue;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) continue;
    if (now.getTime() - ts < DEDUP_TTL_MS) return true;
  }
  return false;
}

/** FIFO 容量控制：先按条数上限截（删头部最老），再按字节上限削，直到都满足。
 *  字节按每行 JSON + '\n' 的 UTF-8 字节数计。 */
export function trimFifo(records: Observation[], maxObservations: number, maxBytes: number): Observation[] {
  let out = records.slice();
  if (out.length > maxObservations) out = out.slice(out.length - maxObservations);
  const lineBytes = (o: Observation): number => Buffer.byteLength(JSON.stringify(o) + '\n', 'utf-8');
  let total = out.reduce((s, o) => s + lineBytes(o), 0);
  while (total > maxBytes && out.length > 0) {
    total -= lineBytes(out[0]);
    out = out.slice(1);
  }
  return out;
}

/** 读全文件 → Observation[]（不存在/空/解析失败 → 空数组，静默降级）。
 *  export 供 generator 归纳层复用（读 observations 喂 LLM）。 */
export function readObservations(file: string): Observation[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Observation);
  } catch {
    return [];
  }
}

/** 重写全文件（确保目录存在；空记录写空文件）。 */
function writeObservations(file: string, records: Observation[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const data = records.map((o) => JSON.stringify(o)).join('\n') + (records.length ? '\n' : '');
  writeFileSync(file, data, 'utf-8');
}

/**
 * 记录一条观察（agent.ts:373 UserPromptSubmit 时机调用）。失败静默降级，不影响主循环（§15）。
 * 流程：enabled 检查 → 正则匹配（不中不记）→ redact+截断 → O(N) 窗口去重 → FIFO 容量控制 → 重写。
 *
 * @param opts.file 显式文件路径（测试用）；默认 <cwd>/.ecode/observations.jsonl
 * @param opts.now  显式当前时间（测试用）；默认 new Date()
 */
export function recordObservation(
  text: string,
  ctx: ObservationContext,
  config: SkillCaptureConfig,
  opts?: { file?: string; now?: () => Date },
): void {
  try {
    if (!config.enabled) return;
    const matched = matchSignal(text, config.patterns);
    if (!matched) return;
    const now = (opts?.now ?? (() => new Date()))();
    const obs = buildObservation(text, matched.signal, ctx, now);
    const file = opts?.file ?? defaultObservationsPath();
    const records = readObservations(file);
    if (isDuplicate(records.slice(-DEDUP_WINDOW), obs.content, now)) return;
    const trimmed = trimFifo([...records, obs], config.maxObservations, config.maxBytes);
    writeObservations(file, trimmed);
  } catch {
    // 静默降级：记录失败不抛（不污染主循环 / 不打断用户输入）
  }
}
