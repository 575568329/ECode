import { MAX_OUTPUT_LENGTH } from './types.js';

/**
 * 截断长文本，末尾标注「共 N 字符 / 仅显示前 M」，让 LLM 知道内容不完整。
 * 静默截断会让人误以为「日志/输出就是全部」，故必须显式标注。
 */
export function truncate(text: string, max: number = MAX_OUTPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... (已截断，共 ${text.length} 字符，仅显示前 ${max} 字符)`;
}

/** read_file 按行截断默认值 */
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_LINE_CHARS = 2000;

/**
 * 按行截断文本（用于 read_file 等工具）。
 *
 * 两个维度：
 * 1. 总行数限制（maxLines，默认 2000 行）
 * 2. 单行字符限制（maxLineChars，默认 2000 字符）
 *
 * 超限时标注被截断的行数和/或字符数，让 LLM 知道内容不完整。
 * 代码是按行组织的，按行截断不劈开单行（对比按字符截断）。
 */
export function truncateByLines(
  text: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxLineChars: number = DEFAULT_MAX_LINE_CHARS,
): string {
  if (!text) return text;

  const lines = text.split('\n');
  const totalLines = lines.length;

  // 行数未超限 → 只检查单行字符
  if (totalLines <= maxLines) {
    const truncated = lines.map((line) =>
      line.length > maxLineChars
        ? line.slice(0, maxLineChars) + `\n  ... (该行已截断，共 ${line.length} 字符，仅显示前 ${maxLineChars} 字符)`
        : line,
    );
    return truncated.join('\n');
  }

  // 行数超限 → 先取前 maxLines 行，再截断单行
  const kept = lines.slice(0, maxLines);
  const truncated = kept.map((line) =>
    line.length > maxLineChars
      ? line.slice(0, maxLineChars) + `\n  ... (该行已截断，共 ${line.length} 字符，仅显示前 ${maxLineChars} 字符)`
      : line,
  );

  return truncated.join('\n') + `\n\n... (已截断，共 ${totalLines} 行，仅显示前 ${maxLines} 行)`;
}
