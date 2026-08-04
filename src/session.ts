// session.ts —— 纯数据层,零 LLM / agent 依赖。
// 设计见 docs/M3-实施方案.md §3.4(类型契约)/ §6(完整设计:命名/slug/原子写/写盘失败处理/续接语义)。
// 同步 fs,对齐 runtime-logger 的"实时写、崩溃不丢"哲学。

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { ECodeMessage } from './providers/types.js';

// ============================================================
// 类型(§3.4)
// ============================================================

export interface ECodeSessionStats {
  rounds: number; // agent 迭代轮数
  compressed: boolean; // 是否发生过压缩(信息用;M3 不据此控制行为——方案解析 §4.3)
  toolCalls: number; // 累计工具调用数
}

export interface ECodeSession {
  id: string; // 时间戳 YYYYMMDDHHmmss,保证唯一
  task: string; // 首句任务(--continue 追加的新任务不覆盖此字段)
  model: string;
  messages: ECodeMessage[];
  createdAt: string; // ISO
  updatedAt: string; // ISO(每次 save 刷新)
  stats: ECodeSessionStats;
}

/** 列表用的轻量摘要(不含 messages) */
export type ECodeSessionSummary = Pick<
  ECodeSession,
  'id' | 'task' | 'model' | 'createdAt' | 'updatedAt' | 'stats'
>;

/** loadSession 找不到指定 id 时抛 */
export class SessionNotFoundError extends Error {}

// ============================================================
// 内部工具
// ============================================================

const SLUG_MAX_LENGTH = 30;
const SLUG_ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/** baseDir 默认值:项目级 .ecode/sessions(决策 C——项目相对路径,无 WSL↔Windows home 错位问题)。 */
function defaultBaseDir(): string {
  return resolve(process.cwd(), '.ecode', 'sessions');
}

/** 解析 baseDir(测试注入优先,默认兜底)。 */
function resolveBaseDir(baseDir?: string): string {
  return baseDir ?? defaultBaseDir();
}

/**
 * task → 文件名友好的 slug(决策④):
 * ① 中文保留(三平台文件系统均支持 Unicode);
 * ② 非法字符 [\/:*?"<>|] 与空白 → -;
 * ③ 连续分隔符折叠为单个 -;
 * ④ 截断到 30 字符(并去尾部 -);
 * ⑤ 全空 / 全非法 → 回退 "session"。
 * slug 仅可读性,文件唯一性由 id 保证(§6.1)。
 */
export function taskToSlug(task: string): string {
  let slug = task
    .replace(SLUG_ILLEGAL_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX_LENGTH) {
    slug = slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, '');
  }
  return slug.length > 0 ? slug : 'session';
}

/** 组装文件路径:<dir>/<id>_<slug>.json。 */
function buildFilePath(id: string, slug: string, dir: string): string {
  return join(dir, `${id}_${slug}.json`);
}

/** 在 dir 下按 id 前缀查找已存在的文件(loadSession 只知 id 不知 slug)。返回绝对路径或 undefined。 */
function findFileById(id: string, dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const prefix = `${id}_`;
  const matched = readdirSync(dir).find(
    (name) => name.startsWith(prefix) && name.endsWith('.json'),
  );
  return matched ? join(dir, matched) : undefined;
}

/** ECodeSession → 摘要(剔除 messages)。 */
function toSummary(session: ECodeSession): ECodeSessionSummary {
  const { id, task, model, createdAt, updatedAt, stats } = session;
  return { id, task, model, createdAt, updatedAt, stats };
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 整文件覆盖写 + 原子写(tmp + rename)+ 写盘失败重试一次(§6.2 / §6.6)。
 * 同 id 二次落盘 = 覆盖原文件(§6.5 续接覆盖语义,文件唯一性由 id 保证)。
 * 不 mutate 入参 session。返回文件绝对路径。
 */
export function saveSession(session: ECodeSession, baseDir?: string): string {
  const dir = resolveBaseDir(baseDir);
  mkdirSync(dir, { recursive: true });

  const slug = taskToSlug(session.task);
  const filePath = buildFilePath(session.id, slug, dir);

  // 原子写:先写 .tmp 再 rename(POSIX/Win 均原子),防进程被强杀于写盘中途留截断损坏文件。
  const writeAtomically = (): void => {
    writeFileSync(`${filePath}.tmp`, JSON.stringify(session, null, 2), 'utf-8');
    renameSync(`${filePath}.tmp`, filePath);
  };

  try {
    writeAtomically();
  } catch {
    // 写盘重试一次(对齐 Claude Code appendToFile;主要吃 Windows 杀毒瞬锁等瞬时故障)。
    writeAtomically();
  }
  return filePath;
}

/**
 * 按 id 加载 session。找不到 → SessionNotFoundError;损坏 JSON → 抛清晰错误(含文件路径)。
 */
export function loadSession(id: string, baseDir?: string): ECodeSession {
  const dir = resolveBaseDir(baseDir);
  const filePath = findFileById(id, dir);
  if (!filePath) {
    throw new SessionNotFoundError(`找不到会话 ${id}(查找目录:${dir})`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`读取会话文件失败:${filePath}\n${(e as Error).message}`);
  }

  try {
    return JSON.parse(raw) as ECodeSession;
  } catch (e) {
    throw new Error(`会话文件 JSON 解析失败:${filePath}\n${(e as Error).message}`);
  }
}

/**
 * 列出全部 session 摘要。按 updatedAt 倒序;跳过损坏文件(末尾 console.warn 提示跳过数)。
 */
export function listSessions(baseDir?: string): ECodeSessionSummary[] {
  const dir = resolveBaseDir(baseDir);
  if (!existsSync(dir)) return [];

  const jsonFiles = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const summaries: ECodeSessionSummary[] = [];
  let corrupted = 0;

  for (const name of jsonFiles) {
    try {
      const session = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ECodeSession;
      summaries.push(toSummary(session));
    } catch {
      corrupted++;
    }
  }

  // updatedAt 倒序(ISO 8601 同格式字符串字典序 = 时间序)
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  if (corrupted > 0) {
    console.warn(`[session] 跳过 ${corrupted} 个损坏的会话文件(目录:${dir})`);
  }
  return summaries;
}

/** 返回 updatedAt 最新的 session id;无 session → undefined。 */
export function latestSessionId(baseDir?: string): string | undefined {
  return listSessions(baseDir)[0]?.id;
}
