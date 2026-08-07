import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolResult } from './types.js';

export interface WriteFileInput {
  path: string;
  content: string;
}

/**
 * 整文件写入(覆盖语义)。
 *
 * - 自动创建嵌套目录(mkdirSync recursive),写到不存在的子目录不会 ENOENT;
 * - 已存在文件直接覆盖(防覆盖留 M4 权限层 dangerous 兜底);
 * - 参数名用 path(项目内 read/edit/grep/glob 一致),非 CCode 的 file_path。
 */
export function executeWriteFile(input: WriteFileInput): ToolResult {
  try {
    mkdirSync(dirname(input.path), { recursive: true });
    writeFileSync(input.path, input.content, 'utf-8');
    return {
      content: `已写入 ${input.content.length} 字符到 ${input.path}`,
      isError: false,
    };
  } catch (err) {
    return {
      content: `写入文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
