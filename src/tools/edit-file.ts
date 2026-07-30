import { readFileSync, writeFileSync } from 'node:fs';
import { ToolResult } from './types.js';
import { truncate } from './truncate.js';

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * 精确替换文件中的文本片段。
 *
 * 关键策略（aider 核心洞察）：oldText 必须在文件中唯一匹配。
 *   - 0 次匹配：回喂文件真实内容（带行号）让 LLM 重试
 *   - 多次匹配：要求 LLM 补充更多上下文使其唯一
 *   - 唯一匹配：替换并写回
 * 匹配失败时回喂真实行，是 agent 编辑正确性的核心（把重构成功率从 20% 拉到 61%）。
 */
export function executeEditFile(input: EditFileInput): ToolResult {
  let content: string;
  try {
    content = readFileSync(input.path, 'utf-8');
  } catch (err) {
    return {
      content: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const occurrences = countOccurrences(content, input.oldText);

  if (occurrences === 0) {
    return {
      content: `未找到指定文本。请核对文件实际内容后重试（oldText 必须与文件完全一致，包括空格和换行）。\n\n文件当前内容（带行号）：\n${truncate(withLineNumbers(content), 50_000)}`,
      isError: true,
    };
  }

  if (occurrences > 1) {
    return {
      content: `oldText 在文件中出现 ${occurrences} 次，无法定位唯一位置。请在 oldText 中包含更多上下文使其唯一。\n\n文件当前内容（带行号）：\n${truncate(withLineNumbers(content), 50_000)}`,
      isError: true,
    };
  }

  const newContent = content.replace(input.oldText, input.newText);
  try {
    writeFileSync(input.path, newContent, 'utf-8');
  } catch (err) {
    return {
      content: `写入文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  return {
    content: `已替换。文件 ${input.path} 更新成功（原 ${content.length} 字符 → 新 ${newContent.length} 字符）。`,
    isError: false,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function withLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
}
