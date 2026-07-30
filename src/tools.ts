import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ============================================================
// 工具定义（Anthropic Tool 格式）
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

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
];

// ============================================================
// 工具执行
// ============================================================

const MAX_OUTPUT_LENGTH = 30_000; // 防止撑爆上下文

export interface ToolResult {
  content: string;
  isError: boolean;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return executeReadFile(input as { path: string });
    case 'bash':
      return executeBash(input as { command: string });
    default:
      return { content: `未知工具: ${name}`, isError: true };
  }
}

// export 以便单元测试；运行时也被 executeReadFile/executeBash 内部使用
export function truncate(text: string, max: number = MAX_OUTPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... (已截断，共 ${text.length} 字符，仅显示前 ${max} 字符)`;
}

function executeReadFile(input: { path: string }): ToolResult {
  try {
    const content = readFileSync(input.path, 'utf-8');
    return { content: truncate(content, 50_000), isError: false };
  } catch (err) {
    return {
      content: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeBash(input: { command: string }): ToolResult {
  try {
    const output = execSync(input.command, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return { content: truncate(output), isError: false };
  } catch (err) {
    if (err instanceof Error) {
      // execSync 执行失败时（exit code != 0），stderr 在 error.message 里
      return { content: truncate(err.message), isError: true };
    }
    return { content: `执行失败: ${String(err)}`, isError: true };
  }
}
