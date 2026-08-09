// ============================================================
// 技能提案 frontmatter 序列化/解析（M6 阶段D §4 归纳层）—— 零依赖手 split
// ============================================================
//
// 与 skills/loader.ts 的 parseSkillFile 区别：
//   - parseSkillFile：解析「已上线 skill」frontmatter（name/description/allowedTools/model）。
//   - 本文件：解析/序列化「提案 proposal」frontmatter（多 status/version/date/hash/evidence 字段）。
//
// evidence 是 Ratchet 证据（归纳时填，accept 时剥除）。序列化用 JSON.stringify 包 content
// （转义引号/特殊字符），解析用 JSON.parse 还原——避免自写 YAML 转义的脆弱。
// 不引 gray-matter / js-yaml：proposal 字段固定且少，手 split 足够（§9.3 零原生依赖）。

/** Ratchet 证据：归纳时引用的具体观察记录（脱敏后）。 */
export interface Evidence {
  ts: string;
  session: string;
  content: string;
}

/** 提案 frontmatter（照 openclaw，+ evidence Ratchet 证据）。 */
export interface ProposalFrontmatter {
  name: string;
  description: string;
  status: string;
  version: number;
  date: string;
  hash: string;
  evidence: Evidence[];
}

/** frontmatter 头尾分隔符：① YAML 段 ② 正文。容忍 CRLF。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * 序列化提案为 SKILL.md 字符串（写 .ecode/skill-proposals/<name>.md）。
 * evidence.content 用 JSON.stringify 包（转义双引号/换行），保证 round-trip 安全。
 */
export function serializeProposal(fm: ProposalFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description}`);
  lines.push(`status: ${fm.status}`);
  lines.push(`version: ${fm.version}`);
  lines.push(`date: ${fm.date}`);
  lines.push(`hash: ${fm.hash}`);
  lines.push('evidence:');
  for (const e of fm.evidence) {
    lines.push(`  - ts: ${e.ts}`);
    lines.push(`    session: ${e.session}`);
    lines.push(`    content: ${JSON.stringify(e.content)}`);
  }
  lines.push('---');
  lines.push(body);
  return lines.join('\n');
}

/** 解析 YAML 标量值：JSON 字符串（双引号）→ JSON.parse；裸串原样。 */
function parseScalar(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1); // 非法 JSON → 剥首尾引号兜底
    }
  }
  return raw;
}

/**
 * 解析提案 SKILL.md → { frontmatter, body }。
 * 无 frontmatter / 缺 name → null（调用方跳过）。
 * evidence 数组按 `  - ts:` 分条，session/content 缩进子字段归属当前条目。
 */
export function parseProposal(
  content: string,
): { frontmatter: ProposalFrontmatter; body: string } | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const [, fmRaw, body] = m;

  const fm: Record<string, unknown> = {};
  const evidence: Evidence[] = [];
  let cur: Partial<Evidence> | null = null;

  const flush = () => {
    if (cur && cur.ts && cur.session && cur.content !== undefined) {
      evidence.push(cur as Evidence);
    }
    cur = null;
  };

  for (const line of fmRaw.split(/\r?\n/)) {
    // evidence 新条目：`  - ts: ...`
    const evStart = line.match(/^\s+-\s+ts:\s*(.*)$/);
    if (evStart) {
      flush(); // 上一条收尾
      cur = { ts: evStart[1].trim() };
      continue;
    }
    // evidence 子字段（缩进）
    const evSession = line.match(/^\s+session:\s*(.*)$/);
    if (evSession && cur) {
      cur.session = evSession[1].trim();
      continue;
    }
    const evContent = line.match(/^\s+content:\s*(.*)$/);
    if (evContent && cur) {
      cur.content = parseScalar(evContent[1].trim());
      continue;
    }
    // 普通顶格字段 key: value（evidence 数组标记本身跳过）
    const kv = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (kv) {
      const [, key, val] = kv;
      if (key === 'evidence') continue; // 数组开始标记，子项走 evStart 分支
      if (key === 'version') fm.version = Number(val);
      else fm[key] = val.trim();
    }
  }
  flush(); // 最后一条

  if (!fm.name || !fm.description) return null; // 必填缺失
  fm.evidence = evidence;
  return { frontmatter: fm as unknown as ProposalFrontmatter, body: body.trim() };
}
