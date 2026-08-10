/**
 * Runtime Logger — Agent Loop 的运行时日志
 *
 * 设计：主日志（摘要）+ 旁路完整报文（raw/*.json）双层结构
 *   - 主日志 .md      人类可读摘要，截断处显式标注「共 N 字符 / 显示前 M / 完整见 raw/...」
 *   - raw/round-N.req.json｜resp.json  完整 API 报文（结构化 JSON，方便 jq 查）
 *
 * 为什么不全塞进 .md：
 *   - 完整报文动辄上万字符，塞 .md 会淹没元数据、难以阅读
 *   - 静默截断会让人误以为「日志就是全部」（曾导致 text/thinking 看似丢失的错觉）
 *   - 业界实践：主日志记摘要 + 指针，完整 payload 单独存，避免「日志与实际不一致」
 *
 * 使用 appendFileSync 实时写主日志，进程崩溃不丢
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_ROOT = resolve(__dirname, '..', 'docs', 'logs', 'runtime');

/**
 * 子代理 runtime-log 隔离根目录 = <baseDir>/_subagents。
 * 子代理是黑盒侦察兵,其 log 不该淹没主会话的 docs/logs/runtime/<date>/。
 * 与 session.ts subagentBaseDir 对称:子代理 session 与 runtime-log 都隔离到 _subagents 子目录。
 */
export function subagentLogRoot(baseDir?: string): string {
  return resolve(baseDir ?? LOG_ROOT, '_subagents');
}

let logPath = '';
let dateDir = ''; // 主日志所在日期目录（<baseDir>/<date>，主 .md 平铺于此）
// 本 session 独立子目录（<dateDir>/<sessionId>，raw 挂其下）。
// 历史教训：raw 曾挂在 <date>/raw/ 下与同日其它 session 共享，后启动的 session 会覆盖前者的
// round-N.json，导致主日志「完整报文见 raw/round-N.json」指向错误文件。故 raw 按 session 隔离。
let sessionRawDir = '';
let rawRelPrefix = ''; // 主日志引用 raw 用的相对前缀（= sessionId）
let startTime = 0;
let roundStartTime = 0;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * 把完整 payload 写到 raw/round-{round}.{kind}.json
 * 返回相对会话目录的路径，供主日志引用（让读者知道「还有更多，去这看」）
 */
function saveRaw(round: number, kind: string, payload: unknown): string {
  const rawDir = resolve(sessionRawDir, 'raw');
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
  const fileName = `round-${round}.${kind}.json`;
  writeFileSync(resolve(rawDir, fileName), JSON.stringify(payload, null, 2), 'utf-8');
  // 相对 dateDir 的路径，供主日志引用（指向本 session 独立 raw）
  return `${rawRelPrefix}/raw/${fileName}`;
}

export function initRuntimeLog(task: string, model: string, endpoint?: string, baseDir?: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toISOString().slice(11, 19).replace(/:/g, ''); // HHmmss
  const sessionId = `${date}_${time}`;

  // baseDir 注入（测试隔离用 tmpdir）；默认写项目 docs/logs/runtime（生产路径）
  const root = baseDir ?? LOG_ROOT;
  dateDir = resolve(root, date);
  if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true });

  logPath = resolve(dateDir, `${sessionId}.md`);
  sessionRawDir = resolve(dateDir, sessionId);
  rawRelPrefix = sessionId;
  startTime = Date.now();
  roundStartTime = startTime;

  appendFileSync(logPath, [
    `# ECode Runtime Debug Log`,
    ``,
    `- **Session**: ${sessionId}`,
    `- **Task**: ${task}`,
    `- **Model**: ${model}`,
    `- **Endpoint**: ${endpoint ?? '(未提供)'}`,
    `- **Time**: ${now.toISOString()}`,
    ``,
    `> 主日志为摘要，完整 API 报文见同目录 \`<sessionId>/raw/round-N.req.json\` / \`round-N.resp.json\``,
    ``,
    '─'.repeat(60),
    ``,
  ].join('\n'));

  return logPath;
}

export function logApiRequest(round: number, messages: unknown[], tools: unknown[]): void {
  roundStartTime = Date.now();

  // 完整请求报文落盘（messages 可能很长，不塞主日志）
  const rawFile = saveRaw(round, 'req', { messages, toolCount: tools.length });

  // 主日志只记摘要：前 3 条消息预览 + 总数 + 指针
  const previewMessages = (messages as unknown[]).slice(0, 3);
  const truncated = messages.length > 3;

  appendFileSync(logPath, [
    `## Round ${round}`,
    ``,
    `### [${ts()}] API Request`,
    ``,
    `- **messages**: 共 ${messages.length} 条${truncated ? `（主日志仅显示前 3 条，完整见 ${rawFile}）` : ''}`,
    ``,
    '```json',
    JSON.stringify({ previewMessages, toolCount: tools.length }, null, 2).slice(0, 5000),
    '```',
    ``,
  ].join('\n'));
}

export function logApiResponse(
  round: number,
  content: unknown[],
  stopReason: { unified: string; raw?: string } | string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  const duration = Date.now() - roundStartTime;

  // 完整响应报文（含 text/thinking/tool_use 全文）落盘
  const rawFile = saveRaw(round, 'resp', { content, stopReason, usage });

  // 主日志：每个 block 一行摘要，长内容显式标注「共 N / 显示前 M / 完整见 raw」
  let blocks = '';
  for (const block of content as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      const LIMIT = 200;
      if (text.length > LIMIT) {
        blocks += `  [text] ${text.slice(0, LIMIT)}\n        ↳ 共 ${text.length} 字符，此处仅显示前 ${LIMIT}，完整见 ${rawFile}\n`;
      } else {
        blocks += `  [text] ${text}\n`;
      }
    } else if (block.type === 'tool_use') {
      blocks += `  [tool_use] ${block.id} → ${block.name}(${JSON.stringify(block.input)})\n`;
    } else if (block.type === 'thinking') {
      const len = String(block.thinking ?? '').length;
      blocks += `  [thinking] 推理过程 ${len} 字符（不在终端展示，完整见 ${rawFile}）\n`;
    } else {
      blocks += `  [${block.type}] 完整见 ${rawFile}\n`;
    }
  }

  appendFileSync(logPath, [
    `### [${ts()}] API Response (${duration}ms)`,
    ``,
    `- **stop_reason**: ${typeof stopReason === 'string' ? stopReason : `${stopReason.unified}${stopReason.raw ? ` (${stopReason.raw})` : ''}`}`,
    `- **input_tokens**: ${usage?.inputTokens ?? '?'}`,
    `- **output_tokens**: ${usage?.outputTokens ?? '?'}`,
    `- **duration**: ${duration}ms`,
    `- **完整报文**: ${rawFile}`,
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
    output.length > 1000 ? `\n... (共 ${output.length} 字符，此处仅显示前 1000)` : '',
    '```',
    ``,
  ].join('\n'));
}

export function logError(source: string, err: unknown): void {
  // 守卫：logPath 模块级单例，测试间可能残留指向已清理的 tmpdir（或文件被外部删除）。
  // 此时跳过写入，避免 ENOENT 二次崩溃——log 本就是最佳努力，不该拖垮调用方。
  if (!logPath || !existsSync(logPath)) return;
  appendFileSync(logPath, [
    `### [${ts()}] ❌ ERROR [${source}]`,
    ``,
    '```',
    err instanceof Error ? `Message: ${err.message}\nStack: ${err.stack}` : String(err),
    '```',
    ``,
  ].join('\n'));
}

/**
 * 记录非致命警告（如跨 provider 路由降级、配置缺失的优雅回退）。
 * 与 logError 区别：这是「能继续跑但偏离预期」的情况，供排查「为何子任务没按路由落点执行」。
 * runtime-log 未初始化时静默（对齐 logSessionSave 兜底，避免降级路径上无谓抛错）。
 */
export function logWarning(source: string, message: string): void {
  if (!logPath || !existsSync(logPath)) return;
  appendFileSync(logPath, [
    `### [${ts()}] ⚠️ WARNING [${source}]`,
    ``,
    message,
    ``,
  ].join('\n'));
}

/** 记录 session 落盘事件（路径、ID、task、消息数、轮数），便于排查文件重复/丢失问题。 */
export function logSessionSave(
  filePath: string,
  sessionId: string,
  task: string,
  messageCount: number,
  rounds: number,
): void {
  if (!logPath) return; // runtime-log 未初始化时静默
  appendFileSync(logPath, `### [${ts()}] 💾 Session 落盘 → ${filePath} (id=${sessionId}, task=${task}, msgs=${messageCount}, rounds=${rounds})\n\n`);
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
