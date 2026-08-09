// ============================================================
// 技能归纳层（M6 阶段D §4）—— /skill-gen：observations → LLM Ratchet 归纳 → pending 提案
// ============================================================
//
// 流程：读 observations.jsonl → length/2 估 token → 按 budget 分批 → 每批 Ratchet prompt
//   → LLM 归纳候选 SKILL.md → 解析标准化 + 填真实 evidence（不信任 LLM 的 evidence）→
//   安全扫描（三段式 §1，归纳时扫）→ 跨批同名去重（§4 step5）→ 写 .ecode/skill-proposals/<name>.md
//   → pending 封顶（§4 step4：超 MAX_PENDING 按 mtime FIFO 删最老）。
//
// Ratchet（AddyOsmani）：每候选引用真实观察记录作证据；素材不足返回"素材不足"而非硬造。
// 不引 tiktoken：budget 量级判断，length/2 足够且零原生依赖（§9.3）。
//
// 测试隔离：GenerateOptions 注入 observationsFile/proposalsDir/provider，避开生产路径与真实 LLM。

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import type { Observation } from './recorder.js';
import { readObservations } from './recorder.js';
import { serializeProposal, parseProposal, type ProposalFrontmatter } from './frontmatter.js';
import { scanSkillContent, type ScanResult } from './security-scan.js';
import type { ModelProvider, ChatRequest, ECodeResponse } from '../providers/types.js';

/** 多提案分隔符（prompt 要求 LLM 用此分隔多个候选）。 */
export const PROPOSAL_SEPARATOR = '===PROPOSAL===';
/** 默认 budget（兜底；生产宜传 model contextWindow 的一半，留空间给 prompt+输出）。 */
const DEFAULT_BUDGET_TOKENS = 32_000;
/** pending 提案上限（照 openclaw maxPending=50）：超限按 mtime FIFO 删最老（§4 step4）。 */
export const MAX_PENDING = 50;

/** length/2 估 token（中文≈1字/token、英文≈2字符/token 的折中，零依赖）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * 按预算分批 observations（纯 token 累计切分，超 budget 开新批）。
 * 不拆单条（单条超 budget 仍独占一批——极端情况，归纳时 LLM 自处理）。
 */
export function batchObservations(obs: Observation[], budget: number): Observation[][] {
  if (obs.length === 0) return [];
  const batches: Observation[][] = [];
  let cur: Observation[] = [];
  let curTokens = 0;
  for (const o of obs) {
    const t = estimateTokens(o.content);
    if (cur.length > 0 && curTokens + t > budget) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(o);
    curTokens += t;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 构造 Ratchet 归纳 prompt（约束 LLM 只从真实记录归纳，输出标准 SKILL.md）。 */
export function buildRatchetPrompt(batch: Observation[]): string {
  const records = batch
    .map((o, i) => `[${i + 1}] ts=${o.ts} session=${o.session}\n${o.content}`)
    .join('\n---\n');
  return [
    '你是一个技能归纳助手。从以下真实用户观察记录中归纳可复用的技能（SKILL.md）。',
    '',
    '严格遵守（Ratchet 原则，防投机）：',
    '1. 每个技能必须基于真实记录；evidence 由系统填充，你只需输出 name/description/正文。',
    '2. 不要 brainstorm——只从真实记录归纳；素材不足时只输出"素材不足，继续记录"。',
    `3. 输出标准 SKILL.md（--- frontmatter --- + 正文）。多个候选用 ${PROPOSAL_SEPARATOR} 分隔。`,
    '4. frontmatter 只含 name、description（≤160 字节）；status/version/date/hash/evidence 由系统填，你省略。',
    '',
    '观察记录：',
    records,
    '',
    '现在输出归纳出的技能（若无足够素材，只输出"素材不足，继续记录"）：',
  ].join('\n');
}

/** 从 LLM 响应提取文本（content 可能是 string 或 text block 数组）。 */
function extractText(resp: ECodeResponse): string {
  const c = resp.content;
  if (typeof c === 'string') return c;
  return c
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 提案记录（落盘 + 审批层消费，§4）。 */
export interface ProposalRecord {
  name: string;
  filePath: string;
  frontmatter: ProposalFrontmatter;
  body: string;
  /** 归纳产出时安全扫描结果（三段式 §1；accept 前再扫 §2）。 */
  scan: ScanResult;
}

export interface GenerateOptions {
  provider: ModelProvider;
  model: string;
  /** token budget（每批上限）；默认 DEFAULT_BUDGET_TOKENS。 */
  budgetTokens?: number;
  /** observations 文件路径（测试注入）；默认 <cwd>/.ecode/observations.jsonl。 */
  observationsFile?: string;
  /** 提案写入目录（测试注入）；默认 <cwd>/.ecode/skill-proposals/。 */
  proposalsDir?: string;
  /** 当前日期（测试注入，date/hash 用）；默认今天 ISO 日期。 */
  now?: string;
}

export interface GenerateResult {
  proposals: ProposalRecord[];
  batches: number;
  totalObservations: number;
  /** 写盘 + FIFO 截断后 skill-proposals/ 下的 pending 总数（app 层据此提示「已达上限，先审批」）。 */
  pendingAfter: number;
}

function defaultObservationsFile(): string {
  return join(process.cwd(), '.ecode', 'observations.jsonl');
}
function defaultProposalsDir(): string {
  return join(process.cwd(), '.ecode', 'skill-proposals');
}

/**
 * 归纳生成技能提案（/skill-gen 核心）。
 * 读 observations → 分批 → 每批 LLM Ratchet 归纳 → 标准化 + 填真实 evidence → 扫描 →
 * 跨批同名去重 → 写盘 → FIFO 封顶。
 * 失败静默降级（单批 LLM 失败 / 单候选解析失败 → 跳过，不打断整体，§15）。
 */
export async function generateProposals(opts: GenerateOptions): Promise<GenerateResult> {
  const observationsFile = opts.observationsFile ?? defaultObservationsFile();
  const proposalsDir = opts.proposalsDir ?? defaultProposalsDir();
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  const observations = readObservations(observationsFile);
  const batches = batchObservations(observations, budget);
  // 跨批同名去重（§4 step5）：同名后者覆盖（取最新批次归纳），写盘前在 Map 内合并。
  const pendingMap = new Map<string, { fm: ProposalFrontmatter; body: string; md: string; scan: ScanResult }>();

  for (const batch of batches) {
    let resp: ECodeResponse;
    try {
      const req: ChatRequest = {
        model: opts.model,
        system: '你是技能归纳助手（Ratchet 原则：只从真实记录归纳，不 brainstorm；素材不足时只回复"素材不足，继续记录"）',
        messages: [{ role: 'user', content: buildRatchetPrompt(batch) }],
        tools: [], // 归纳禁工具（单轮文本生成，非 agent loop）
      };
      resp = await opts.provider.complete(req);
    } catch {
      continue; // 单批 LLM 失败 → 跳过（不打断其他批，§15 静默降级）
    }
    const text = extractText(resp);
    if (text.includes('素材不足')) continue; // Ratchet：素材不足不硬造

    // 多候选按分隔符切分；单候选整段
    const chunks = text.includes(PROPOSAL_SEPARATOR)
      ? text.split(PROPOSAL_SEPARATOR).map((s) => s.trim()).filter(Boolean)
      : [text.trim()];

    for (const chunk of chunks) {
      const parsed = parseProposal(chunk);
      const name = parsed?.frontmatter.name;
      const description = parsed?.frontmatter.description;
      const body = parsed?.body ?? chunk;
      if (!name || !description) continue; // 解析失败/缺必填 → 跳过该候选

      // evidence 用 batch 真实记录填充（Ratchet 全引用，不信任 LLM 自报 evidence）
      const fm: ProposalFrontmatter = {
        name,
        description,
        status: 'proposal',
        version: 1,
        date: now,
        hash: `${now}-${name}`,
        evidence: batch.map((o) => ({ ts: o.ts, session: o.session, content: o.content })),
      };
      const md = serializeProposal(fm, body);
      const scan = scanSkillContent(md);
      pendingMap.set(name, { fm, body, md, scan }); // 同名后者覆盖（跨批去重）
    }
  }

  // 统一写盘（去重后）
  const proposals: ProposalRecord[] = [];
  if (pendingMap.size > 0) {
    mkdirSync(proposalsDir, { recursive: true });
    for (const [name, { fm, body, md, scan }] of pendingMap) {
      const filePath = join(proposalsDir, `${name}.md`);
      writeFileSync(filePath, md, 'utf-8');
      proposals.push({ name, filePath, frontmatter: fm, body, scan });
    }
  }
  // 封顶：pending 总数 > MAX_PENDING → 按 mtime 升序删最老（FIFO，§4 step4）
  enforceMaxPending(proposalsDir, MAX_PENDING);

  return {
    proposals,
    batches: batches.length,
    totalObservations: observations.length,
    pendingAfter: countProposals(proposalsDir),
  };
}

/**
 * pending 封顶（§4 step4）：skill-proposals/*.md 总数 > max → 按 mtime 升序删最老至 max。
 * 用文件 mtime 判新旧（frontmatter date 仅天级，无法区分同日先后）；删失败静默（幂等）。
 */
function enforceMaxPending(proposalsDir: string, max: number): void {
  let entries: string[];
  try {
    entries = readdirSync(proposalsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return; // 目录不存在 → 无需封顶
  }
  if (entries.length <= max) return;
  const stamped = entries
    .map((f) => ({ f, mtime: statSync(join(proposalsDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime); // 升序：最老在前
  for (const { f } of stamped.slice(0, stamped.length - max)) {
    try {
      unlinkSync(join(proposalsDir, f));
    } catch {
      // 静默：文件可能已被外部删（幂等）
    }
  }
}

/** 数 skill-proposals/*.md 总数（GenerateResult.pendingAfter；目录不存在 → 0）。 */
function countProposals(proposalsDir: string): number {
  try {
    return readdirSync(proposalsDir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}
