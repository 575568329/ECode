import { readdirSync } from 'node:fs';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

export interface LsInput {
  path?: string;
  pattern?: string;
}

/**
 * 列目录(默认一层,不递归)。
 *
 * - pattern 为子串过滤(非 glob;需 glob 匹配用 glob 工具),description 已明示避免 LLM 误用;
 * - 输出按名排序,每行一项,truncate 防撑爆上下文。
 */
export function executeLs(input: LsInput): ToolResult {
  const dir = input.path ?? process.cwd();
  try {
    let entries = readdirSync(dir);
    if (input.pattern) {
      const p = input.pattern;
      entries = entries.filter((e) => e.includes(p));
    }
    if (entries.length === 0) {
      return { content: '空目录或无匹配条目。', isError: false };
    }
    return { content: truncate(entries.sort().join('\n'), 30_000), isError: false };
  } catch (err) {
    return {
      content: `列目录失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
