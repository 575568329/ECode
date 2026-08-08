// 子代理（支点 9）loader：读 .ecode/agents/*.md（user + project 两层）→ AgentDefinition[]。
//
// 设计：
//   - frontmatter 用极简手写解析（name/description/tools/model 四个标量字段，不引 YAML 依赖）。
//   - 两层作用域：user（~/.ecode/agents，走 resolveDataDir §9.3 跨平台）+ project（<cwd>/.ecode/agents，
//     git 跟踪）。同名 project 覆盖 user（project 胜，后加载覆盖前者）。
//   - 单文件读/解析失败静默跳过（一条坏人设不砖住整个加载，对齐 config/settings-loader 降级风格）。
//   - 跨平台行尾：正则用 \r?\n 兼容 CRLF（debugging #011 Windows CRLF 陷阱）。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../paths.js';
import type { AgentDefinition } from './types.js';

const AGENTS_SUBDIR = 'agents';

/** frontmatter 头尾分隔符之间的捕获组：① YAML 段 ② 正文。容忍 CRLF。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** frontmatter 单行 key: value（key 须合法标识符）。 */
const FM_LINE_RE = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/;

/**
 * 解析单个 agent .md 文件内容 → AgentDefinition。
 * 无 frontmatter / 缺 name → null（调用方跳过）。
 */
export function parseAgentFile(content: string): AgentDefinition | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const [, frontmatter, body] = m;

  const fm: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const lm = line.match(FM_LINE_RE);
    if (lm) fm[lm[1]] = lm[2].trim();
  }

  const name = fm.name;
  if (!name) return null; // 缺 name 无法被主 LLM 点名派遣

  const description = fm.description ?? '';
  // tools 支持两种写法：逗号列表（a, b, c）或 YAML 数组（[a, b]）；剥 [] 后按逗号切。
  const tools = fm.tools
    ? fm.tools
        .replace(/[[\]]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const model = fm.model || undefined;
  const systemPrompt = body.trim();

  return { name, description, tools, model, systemPrompt };
}

/** 读单个 agents 目录下全部合法 *.md → AgentDefinition[]（目录不存在/读失败 → []）。 */
function loadFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // 读目录失败（权限等）静默降级
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const def = parseAgentFile(readFileSync(full, 'utf-8'));
      if (def) agents.push(def);
    } catch {
      // 单文件读/解析失败跳过，不砖住整个加载
    }
  }
  return agents;
}

/**
 * 加载全部子代理人设（user + project 两层合并）。
 * @param opts.dirs 显式指定 agents 目录（测试用）；默认 user（resolveDataDir/agents）+ project（<cwd>/.ecode/agents）。
 * 同名 agent：project 覆盖 user（后加载覆盖）。
 */
export function loadAgents(opts?: { dirs?: string[] }): AgentDefinition[] {
  const dirs = opts?.dirs ?? [
    join(resolveDataDir(), AGENTS_SUBDIR),
    join(process.cwd(), '.ecode', AGENTS_SUBDIR),
  ];
  const byName = new Map<string, AgentDefinition>();
  for (const dir of dirs) {
    for (const a of loadFromDir(dir)) byName.set(a.name, a); // 后加载（project）覆盖先加载（user）
  }
  return [...byName.values()];
}
