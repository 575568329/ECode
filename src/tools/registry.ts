import type { ToolDefinition } from './types.js';
import { executeReadFile } from './read-file.js';
import { executeBash } from './bash.js';
import { executeEditFile } from './edit-file.js';
import { executeGrep } from './grep.js';
import { executeGlob } from './glob.js';

/**
 * 声明式工具清单（v2）：每个工具自带 schema + execute。
 * 新增工具：在此加一条（name + description + parameters + execute）即可，
 * 无需再改 executor.ts 的 switch。
 */
export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取文件内容。当你需要查看文件内容时使用这个工具。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要读取的文件路径（绝对路径或相对当前工作目录）',
        },
      },
      required: ['path'],
    },
    execute: (input) => executeReadFile(input as { path: string }),
  },
  {
    name: 'bash',
    description:
      '执行 shell 命令。当你需要运行命令、安装依赖、编译代码、运行脚本时使用这个工具。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
      },
      required: ['command'],
    },
    execute: (input) => executeBash(input as { command: string }),
  },
  {
    name: 'edit_file',
    description:
      '精确替换文件中的指定文本片段。oldText 必须在文件中唯一匹配（包括空格/换行）；匹配失败时会回显文件真实内容供你重试。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的文件路径' },
        oldText: {
          type: 'string',
          description: '要被替换的原文（必须在文件中唯一，含足够上下文）',
        },
        newText: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: (input) =>
      executeEditFile(input as { path: string; oldText: string; newText: string }),
  },
  {
    name: 'grep',
    description:
      '按正则在文件内容中搜索。返回「相对路径:行号: 行内容」。需要找哪个文件含某段代码时用，不要用 bash + cat。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索根目录（可选，默认当前工作目录）' },
        include: { type: 'string', description: '文件名过滤，如 "*.ts"（可选）' },
      },
      required: ['pattern'],
    },
    execute: (input) =>
      executeGrep(input as { pattern: string; path?: string; include?: string }),
  },
  {
    name: 'glob',
    description:
      '按文件名模式查找文件（如 "**/*.ts"）。需要列出某类文件时用。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名 glob 模式' },
        path: { type: 'string', description: '搜索根目录（可选，默认当前工作目录）' },
      },
      required: ['pattern'],
    },
    execute: (input) => executeGlob(input as { pattern: string; path?: string }),
  },
];
