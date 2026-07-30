import { MAX_OUTPUT_LENGTH } from './types.js';

/**
 * 截断长文本，末尾标注「共 N 字符 / 仅显示前 M」，让 LLM 知道内容不完整。
 * 静默截断会让人误以为「日志/输出就是全部」，故必须显式标注。
 */
export function truncate(text: string, max: number = MAX_OUTPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... (已截断，共 ${text.length} 字符，仅显示前 ${max} 字符)`;
}
