/**
 * Runtime Logger — Agent Loop 的运行时全量日志
 *
 * 每次执行 agent 自动记录到 docs/logs/runtime/YYYY-MM-DD/HHmmss_xxx.md
 * 包含：API 请求/响应报文、工具调用详情、Token 用量、耗时
 *
 * 使用 appendFileSync 实时写入，进程崩溃日志不丢
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_ROOT = resolve(__dirname, '..', 'docs', 'logs', 'runtime');

let logPath = '';
let startTime = 0;
let roundStartTime = 0;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function initRuntimeLog(task: string, model: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toISOString().slice(11, 19).replace(/:/g, ''); // HHmmss
  const sessionId = `${date}_${time}`;

  const dir = resolve(LOG_ROOT, date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  logPath = resolve(dir, `${sessionId}.md`);
  startTime = Date.now();
  roundStartTime = startTime;

  appendFileSync(logPath, [
    `# ECode Runtime Debug Log`,
    ``,
    `- **Session**: ${sessionId}`,
    `- **Task**: ${task}`,
    `- **Model**: ${model}`,
    `- **Time**: ${now.toISOString()}`,
    ``,
    '─'.repeat(60),
    ``,
  ].join('\n'));

  return logPath;
}

export function logApiRequest(round: number, messages: unknown[], tools: unknown[]): void {
  roundStartTime = Date.now();
  appendFileSync(logPath, [
    `## Round ${round}`,
    ``,
    `### [${ts()}] API Request`,
    ``,
    '```json',
    JSON.stringify({ messages, toolCount: tools.length }, null, 2).slice(0, 5000),
    messages.length > 3 ? `\n  // ... 共 ${messages.length} 条消息，仅显示前 3 条` : '',
    '```',
    ``,
  ].join('\n'));
}

export function logApiResponse(
  _round: number,
  content: unknown[],
  stopReason: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  const duration = Date.now() - roundStartTime;

  let blocks = '';
  for (const block of content as Array<{ type: string; [key: string]: unknown }>) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      blocks += `  [text] ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}\n`;
    } else if (block.type === 'tool_use') {
      blocks += `  [tool_use] ${block.id} → ${block.name}(${JSON.stringify(block.input)})\n`;
    } else {
      blocks += `  [${block.type}] ${JSON.stringify(block).slice(0, 200)}\n`;
    }
  }

  appendFileSync(logPath, [
    `### [${ts()}] API Response (${duration}ms)`,
    ``,
    `- **stop_reason**: ${stopReason}`,
    `- **input_tokens**: ${usage?.inputTokens ?? '?'}`,
    `- **output_tokens**: ${usage?.outputTokens ?? '?'}`,
    `- **duration**: ${duration}ms`,
    ``,
    '```',
    blocks.trim(),
    '```',
    ``,
  ].join('\n'));
}

export function logToolExecution(
  _round: number,
  name: string,
  input: unknown,
  output: string,
  isError: boolean,
): void {
  appendFileSync(logPath, [
    `### [${ts()}] Tool Execution: ${name}`,
    ``,
    `- **status**: ${isError ? '❌ ERROR' : '✅ OK'}`,
    `- **input**: ${JSON.stringify(input)}`,
    `- **output_size**: ${output.length} 字符`,
    ``,
    '```',
    output.slice(0, 1000),
    output.length > 1000 ? `\n... (截断，共 ${output.length} 字符)` : '',
    '```',
    ``,
  ].join('\n'));
}

export function logError(source: string, err: unknown): void {
  appendFileSync(logPath, [
    `### [${ts()}] ❌ ERROR [${source}]`,
    ``,
    '```',
    err instanceof Error ? `Message: ${err.message}\nStack: ${err.stack}` : String(err),
    '```',
    ``,
  ].join('\n'));
}

export function finalizeRuntimeLog(totalRounds: number): void {
  const totalTime = Date.now() - startTime;
  appendFileSync(logPath, [
    '─'.repeat(60),
    ``,
    `## 会话结束`,
    ``,
    `- **总轮数**: ${totalRounds}`,
    `- **总耗时**: ${(totalTime / 1000).toFixed(1)}s`,
    ``,
  ].join('\n'));
}
