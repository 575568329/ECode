// read-search-group —— 折叠组延迟冻结的只读工具判定 + 合并摘要。
// 详见 docs/20260806220000_折叠组延迟冻结-详设.md §4.1。
// 连续只读工具(read_file/grep/glob/bash搜索类)合并成一个折叠摘要行；
// 写操作 / 非搜索 bash / 复合命令破坏组（保守判否：宁可漏合不可误合）。

/** 直接判定的只读工具。 */
const READ_SEARCH_TOOLS = new Set(['read_file', 'grep', 'glob']);

/** bash 搜索类命令的 basename 集合。 */
const SEARCH_BASH_CMDS = new Set(['grep', 'rg', 'find', 'ls', 'fd', 'ag', 'cat']);

/** 复合命令元字符：命中即保守判否（管道/逻辑与/分号/命令替换里可能含写操作）。 */
const COMPOUND_CMD_CHARS = /[|;&`$]/;

/**
 * bash 命令是否搜索类。
 * 取首个 token 的 basename 匹配搜索命令集（/usr/bin/grep → grep）；
 * 复合命令(管道/&&/;)保守判否——宁可漏合不可误合（不破坏正确性）。
 */
export function isSearchBash(input?: Record<string, unknown>): boolean {
  const command = String(input?.command ?? '').trim();
  if (!command) return false;
  if (COMPOUND_CMD_CHARS.test(command)) return false;
  const firstToken = command.split(/\s+/)[0];
  const base = firstToken.split('/').pop() ?? firstToken;
  return SEARCH_BASH_CMDS.has(base);
}

/** 工具结果是否属于「只读可合并」组：read_file/grep/glob 直接判定；bash 委托 isSearchBash。 */
export function isReadSearchTool(name: string, input?: Record<string, unknown>): boolean {
  if (READ_SEARCH_TOOLS.has(name)) return true;
  if (name === 'bash') return isSearchBash(input);
  return false;
}

/** 合并摘要：按工具类型分组计数 → "Read 3 files · Searched 2 patterns · 1 glob"。 */
export function summarizeGroup(tools: { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts: string[] = [];
  const r = counts.get('read_file'); if (r) parts.push(`Read ${r} file${r > 1 ? 's' : ''}`);
  const g = counts.get('grep');      if (g) parts.push(`Searched ${g} pattern${g > 1 ? 's' : ''}`);
  const gl = counts.get('glob');     if (gl) parts.push(`${gl} glob${gl > 1 ? 's' : ''}`);
  const b = counts.get('bash');      if (b) parts.push(`${b} search${b > 1 ? 'es' : ''}`);
  return parts.join(' · ');
}
