// Skills（支点 13 阶段1）loader：读 .ecode/skills/*.md（user + project 两层）→ SkillDefinition[]。
//
// 设计对齐子代理 loader（支点9，src/subagent/loader.ts）：
//   - frontmatter 极简手写解析（name/description/allowedTools/model 四字段，不引 YAML 依赖）。
//   - 两层作用域：user（resolveDataDir/skills，§9.3 跨平台）+ project（<cwd>/.ecode/skills，git 跟踪）。
//     同名 project 覆盖 user（后加载覆盖前者）。
//   - 单文件读/解析失败静默跳过（一条坏菜谱不砖住整个加载，对齐 config/settings-loader 降级风格）。
//   - 跨平台行尾：正则用 \r?\n 兼容 CRLF（debugging #011 Windows CRLF 陷阱）。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveDataDir } from '../paths.js';
import type { SkillDefinition, SkillSource } from './types.js';

const SKILLS_SUBDIR = 'skills';

/** frontmatter 头尾分隔符之间的捕获组：① YAML 段 ② 正文。容忍 CRLF。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** frontmatter 单行 key: value（key 须合法标识符）。 */
const FM_LINE_RE = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/;

/** 显式目录 + 其作用域（测试可注入；生产按 user/project 两层）。 */
export interface SkillDir {
  dir: string;
  source: SkillSource;
}

/**
 * 解析单个 skill .md 文件内容 → SkillDefinition。
 * 无 frontmatter / 缺 name（frontmatter + 文件名 stem 都无）→ null（调用方跳过）。
 * name 优先 frontmatter，缺则用文件名 stem（对齐方案「文件名 stem / frontmatter name」）。
 */
export function parseSkillFile(
  content: string,
  source: SkillSource,
  filePath: string,
): SkillDefinition | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const [, frontmatter, body] = m;

  const fm: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const lm = line.match(FM_LINE_RE);
    if (lm) fm[lm[1]] = lm[2].trim();
  }

  const stem = basename(filePath, '.md');
  const name = fm.name || stem;
  if (!name) return null; // frontmatter + stem 都无 name，无法被点名调用

  const description = fm.description ?? '';
  // allowedTools 两种写法：逗号列表（a, b, c）或 YAML 数组（[a, b]）；剥 [] 后按逗号切。
  const allowedTools = fm.allowedTools
    ? fm.allowedTools
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const model = fm.model || undefined;

  return { name, description, allowedTools, model, body: body.trim(), source, filePath };
}

/** 读单个 skills 目录下全部合法 *.md → SkillDefinition[]（目录不存在/读失败 → []）。 */
function loadFromDir(dir: string, source: SkillSource): SkillDefinition[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // 读目录失败（权限等）静默降级
  }

  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const def = parseSkillFile(readFileSync(full, 'utf-8'), source, full);
      if (def) skills.push(def);
    } catch {
      // 单文件读/解析失败跳过，不砖住整个加载
    }
  }
  return skills;
}

/**
 * 加载全部 skill（user + project 两层合并）。
 * @param opts.dirs 显式指定目录 + 作用域（测试用）；默认 user（resolveDataDir/skills）+ project（<cwd>/.ecode/skills）。
 * 同名 skill：project 覆盖 user（后加载覆盖前者）。
 */
export function loadSkills(opts?: { dirs?: SkillDir[] }): SkillDefinition[] {
  const dirs = opts?.dirs ?? [
    { dir: join(resolveDataDir(), SKILLS_SUBDIR), source: 'user' },
    { dir: join(process.cwd(), '.ecode', SKILLS_SUBDIR), source: 'project' },
  ];
  const byName = new Map<string, SkillDefinition>();
  for (const { dir, source } of dirs) {
    for (const s of loadFromDir(dir, source)) byName.set(s.name, s); // 后加载（project）覆盖先加载（user）
  }
  return [...byName.values()];
}
