// ============================================================
// 审批层（M6 阶段D §5）—— /skill accept/reject/edit/promote 状态机 + IO
// ============================================================
//
// 状态机（照 openclaw，去 edit）：
//   pending ──accept──→ applied（落 <cwd>/.ecode/skills/<name>.md，剥 evidence）
//           ├──reject──→ rejected（删提案）
//           ├──critical──→ quarantined（重写 status，不落盘不删，待人工处置）
//   promote → resolveDataDir()/skills/<name>.md（用户级，跨项目）；同名跳过（--force 覆盖）
//   edit：不做（提案/已安装 skill 均普通 .md，用户自行编辑后 /skill 重载，§18 消解）。
//
// 落盘格式：accept/promote 写 **flat `<name>.md`**（仅 name/description + 正文），对齐现有
// skills/loader.ts（readdirSync 读顶层 *.md，不下钻 <name>/SKILL.md）。设计文档 §8 写的
// `<name>/SKILL.md` 子目录布局与已实现 loader 不符——以 loader 为准（source of truth），flat。
//
// 三段式扫描 §6：归纳时扫（generator）+ loadProposals 再扫（accept 前再扫 §6.2）+
// critical 强制 quarantine（accept/promote 都拦）。
//
// 测试隔离：proposalsDir/skillsDir/userSkillsDir 全可注入，不碰生产 .ecode / resolveDataDir。

import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolveDataDir } from '../paths.js';
import { parseProposal, serializeProposal, type ProposalFrontmatter } from './frontmatter.js';
import { scanSkillContent, type ScanResult } from './security-scan.js';

/** 一份 pending 提案（加载时已重新扫描）。 */
export interface ProposalRecord {
  name: string;
  filePath: string;
  frontmatter: ProposalFrontmatter;
  body: string;
  /** accept 前再扫的结果（§6.2）。 */
  scan: ScanResult;
}

function defaultProposalsDir(): string {
  return join(process.cwd(), '.ecode', 'skill-proposals');
}
function defaultProjectSkillsDir(): string {
  return join(process.cwd(), '.ecode', 'skills');
}
function defaultUserSkillsDir(): string {
  return join(resolveDataDir(), 'skills');
}

/**
 * 加载全部 pending 提案（readdir skill-proposals/*.md → parse → 再扫描）。
 * 单文件读/解析失败静默跳过（不砖住整个加载，对齐 loader/config 降级风格）。
 */
export function loadProposals(opts?: { proposalsDir?: string }): ProposalRecord[] {
  const dir = opts?.proposalsDir ?? defaultProposalsDir();
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ProposalRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseProposal(content);
    if (!parsed) continue; // 无 frontmatter / 缺必填 → 跳过
    out.push({
      name: parsed.frontmatter.name,
      filePath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      scan: scanSkillContent(content), // accept 前再扫（含 frontmatter + evidence + body）
    });
  }
  return out;
}

/**
 * 剥除 evidence/状态字段，仅留 name/description → 标准 SKILL.md（skills/loader 可识别）。
 * 与 serializeProposal 的多字段 proposal 形态不同：accepted skill 只需 name/description。
 */
export function stripEvidence(fm: ProposalFrontmatter, body: string): string {
  return ['---', `name: ${fm.name}`, `description: ${fm.description}`, '---', body].join('\n');
}

/** 按名找提案（找不到 → null）。 */
function findProposal(name: string, proposalsDir: string): ProposalRecord | null {
  return loadProposals({ proposalsDir }).find((p) => p.name === name) ?? null;
}

export interface AcceptResult {
  ok: boolean;
  reason?: 'critical' | 'not_found';
  /** accept 落盘的项目级路径（ok=true 时）。 */
  skillPath?: string;
  scan: ScanResult;
}

/**
 * accept：accept 前再扫 → critical 强制 quarantine（重写 status，不落盘不删）→
 * 否则 stripped 落项目级 skill + 删提案。
 */
export function acceptProposal(
  name: string,
  opts?: { proposalsDir?: string; skillsDir?: string },
): AcceptResult {
  const proposalsDir = opts?.proposalsDir ?? defaultProposalsDir();
  const skillsDir = opts?.skillsDir ?? defaultProjectSkillsDir();
  const record = findProposal(name, proposalsDir);
  if (!record) return { ok: false, reason: 'not_found', scan: { findings: [], hasCritical: false } };

  // critical → quarantine（重写 status，保留待人工处置，不落盘）
  if (record.scan.hasCritical) {
    writeFileSync(
      record.filePath,
      serializeProposal({ ...record.frontmatter, status: 'quarantined' }, record.body),
      'utf-8',
    );
    return { ok: false, reason: 'critical', scan: record.scan };
  }

  // stripped 落项目级 + 删提案
  mkdirSync(skillsDir, { recursive: true });
  const skillPath = join(skillsDir, `${name}.md`);
  writeFileSync(skillPath, stripEvidence(record.frontmatter, record.body), 'utf-8');
  try {
    unlinkSync(record.filePath);
  } catch {
    // 删提案失败不回滚已落盘的 skill（apply 已达成主目的；残留提案下次 accept 会被覆盖落盘，幂等）
  }
  return { ok: true, skillPath, scan: record.scan };
}

export interface SimpleResult {
  ok: boolean;
  reason?: 'not_found';
}

/** reject：删提案文件（不存在 → not_found）。 */
export function rejectProposal(name: string, opts?: { proposalsDir?: string }): SimpleResult {
  const proposalsDir = opts?.proposalsDir ?? defaultProposalsDir();
  const record = findProposal(name, proposalsDir);
  if (!record) return { ok: false, reason: 'not_found' };
  try {
    unlinkSync(record.filePath);
  } catch {
    // 静默：文件可能已被外部删（幂等）
  }
  return { ok: true };
}

export interface PromoteResult {
  ok: boolean;
  reason?: 'not_found' | 'critical' | 'exists';
  /** 用户级路径（exists/ok 时）。 */
  userSkillPath?: string;
}

/**
 * promote：stripped 复制到用户级 resolveDataDir()/skills/<name>.md（跨项目）。
 * 同名跳过（不覆盖，提示 --force）；critical 拒绝（与 accept 同闸）。
 */
export function promoteProposal(
  name: string,
  opts?: { proposalsDir?: string; userSkillsDir?: string; force?: boolean },
): PromoteResult {
  const proposalsDir = opts?.proposalsDir ?? defaultProposalsDir();
  const userSkillsDir = opts?.userSkillsDir ?? defaultUserSkillsDir();
  const record = findProposal(name, proposalsDir);
  if (!record) return { ok: false, reason: 'not_found' };

  const userSkillPath = join(userSkillsDir, `${name}.md`);
  // 同名跳过（force 覆盖）
  if (existsSync(userSkillPath) && !opts?.force) {
    return { ok: false, reason: 'exists', userSkillPath };
  }
  // critical 拒绝（与 accept 同安全闸，§6.3）
  if (record.scan.hasCritical) {
    return { ok: false, reason: 'critical', userSkillPath };
  }

  mkdirSync(userSkillsDir, { recursive: true });
  writeFileSync(userSkillPath, stripEvidence(record.frontmatter, record.body), 'utf-8');
  return { ok: true, userSkillPath };
}
