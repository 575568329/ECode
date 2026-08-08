// format-transcript —— DisplayMessage[] → 精简分组的转录纯文本（pager/less 输入）。
// B+ 方案（docs/详设/20260806232155）：按 user 提问分组，只输出「被折叠/裁剪的工具完整 content」——
// 即主界面看不到的关键内容。跳过 assistant/warning/error/未折叠的单工具；
// 无折叠工具的轮次整体跳过；空结果 → 空串（调用方据此不进 pager）。
//
// 「是否折叠」单一规则源：foldContent().folded 标志（策略表驱动，不再 per-tool if-else）。
import { T, SYMBOLS } from './theme.js';
import { summarizeArg, foldContent } from './tool-panel.js';
import type { DisplayMessage } from './types.js';

// ---- ANSI 24-bit 真彩色辅助（ink 走 <Text color> 不需要这些，纯文本输出给 less 才需要）----

/** hex(#RRGGBB) → ANSI 24-bit 前景色转义 \x1b[38;2;R;G;Bm。 */
function fg(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[38;2;${r};${g};${b}m`;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
/** 内容缩进（对齐 renderCompleted 的 paddingLeft，纯文本用 2 空格近似视觉层级）。 */
const INDENT = '  ';

/** 包一段文本着色（指定前景色 + 可选粗体），末尾 RESET。 */
function color(text: string, hex: string, opts?: { bold?: boolean }): string {
  return `${opts?.bold ? BOLD : ''}${fg(hex)}${text}${RESET}`;
}

/** 多行文本块整体缩进（每行前加 INDENT）。空文本返回空串（只标题、无内容行）。 */
function indentBlock(text: string): string {
  if (text.length === 0) return '';
  return text
    .split('\n')
    .map((l) => `${INDENT}${l}`)
    .join('\n');
}

/** 折叠工具的扁平表示（tool_group 展开后的各工具 + 被折叠的单 tool 统一成这个）。 */
interface FoldedTool {
  name: string;
  content: string;
  isError: boolean;
  input?: Record<string, unknown>;
}

/** 判定单个 tool 在主界面是否被折叠/裁剪（→ 该进 less 展开看完整 content）。
 *  单一规则源：直接读 foldContent 的 folded 标志，不再自行 if-else 判断。 */
function isToolFolded(name: string, isError: boolean, content: string): boolean {
  return foldContent(name, isError, content).folded;
}

/** 单个工具 → 转录行块（完整 content，不裁剪——pager 的意义就是看主界面丢掉的完整内容）。 */
function renderTool(t: FoldedTool): string {
  const icon = t.isError ? SYMBOLS.error : SYMBOLS.success;
  const iconHex = t.isError ? T.error : T.success;
  const arg = summarizeArg(t.name, t.input);
  const title = `${color(icon, iconHex)} ${color(t.name, T.tool)}${arg ? color(` (${arg})`, T.muted) : ''}`;
  const body = indentBlock(t.content);
  return body ? `${title}\n${body}` : title;
}

/** 一个对话轮次 = user 提问 + 其后（至下一 user 前）所有被折叠的工具。 */
interface Turn {
  userText: string;
  tools: FoldedTool[];
}

/** 遍历消息构建轮次：user 开新轮；tool_group/被折叠 tool 归入当前轮；其余跳过。
 *  仅保留含折叠工具的轮次（无折叠工具的轮整体丢弃，精简避免空锚点）。 */
function buildTurns(messages: DisplayMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const flushIfFolded = () => {
    if (current && current.tools.length > 0) turns.push(current);
  };
  for (const msg of messages) {
    if (msg.kind === 'user') {
      flushIfFolded();
      current = { userText: msg.text, tools: [] };
    } else if (msg.kind === 'tool_group') {
      if (!current) current = { userText: '', tools: [] }; // 防御：无前导 user 的孤立 group
      current.tools.push(
        ...msg.tools.map((t) => ({ name: t.name, content: t.content, isError: t.isError, input: t.input })),
      );
    } else if (msg.kind === 'tool') {
      if (isToolFolded(msg.name, msg.isError, msg.content)) {
        if (!current) current = { userText: '', tools: [] };
        current.tools.push({ name: msg.name, content: msg.content, isError: msg.isError, input: msg.input });
      }
    }
    // assistant / warning / error：主界面已完整显示，跳过
  }
  flushIfFolded();
  return turns;
}

/** 一个轮次 → 转录块：醒目分隔锚点 + 提问首行摘要 + 各折叠工具完整内容。 */
function renderTurn(turn: Turn, index: number): string {
  const anchor = color(`━━━━━━━━ 对话 ${index} ━━━━━━━━`, T.muted);
  const firstLine = turn.userText.split('\n')[0].trim();
  const prompt = firstLine ? color(`${SYMBOLS.user} ${firstLine}`, T.user) : '';
  const toolBlocks = turn.tools.map(renderTool);
  return [anchor, prompt, ...toolBlocks].filter((s) => s.length > 0).join('\n');
}

/**
 * DisplayMessage[] → 精简分组的转录纯文本（pager/less 输入）。
 * 按 user 提问分组，只含被折叠工具的完整 content；轮间空行分隔；无折叠内容返回空串（不进 pager）。
 */
export function sessionMessagesToTranscript(messages: DisplayMessage[]): string {
  const turns = buildTurns(messages);
  if (turns.length === 0) return '';
  return turns.map((turn, i) => renderTurn(turn, i + 1)).join('\n\n');
}
