import { ToolDefinition } from './types.js';

/**
 * 给 LLM 看的工具清单（Anthropic input_schema 格式）。
 * 新增工具：在此加 schema + executor.ts 加 case + 实现工具函数。
 */
export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取文件内容。当你需要查看文件内容时使用这个工具。',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要读取的文件路径（绝对路径或相对当前工作目录）',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description:
      '执行 shell 命令。当你需要运行命令、安装依赖、编译代码、运行脚本时使用这个工具。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'edit_file',
    description:
      '精确替换文件中的指定文本片段。oldText 必须在文件中唯一匹配（包括空格/换行）；匹配失败时会回显文件真实内容供你重试。',
    input_schema: {
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
  },
  {
    name: 'grep',
    description:
      '按正则在文件内容中搜索。返回「相对路径:行号: 行内容」。需要找哪个文件含某段代码时用，不要用 bash + cat。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索根目录（可选，默认当前工作目录）' },
        include: { type: 'string', description: '文件名过滤，如 "*.ts"（可选）' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description:
      '按文件名模式查找文件（如 "**/*.ts"）。需要列出某类文件时用。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名 glob 模式' },
        path: { type: 'string', description: '搜索根目录（可选，默认当前工作目录）' },
      },
      required: ['pattern'],
    },
  },
];
