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
];
