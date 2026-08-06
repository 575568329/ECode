// format-transcript —— DisplayMessage[] → 带 ANSI 颜色的纯文本转录（pager/less 输入）。
// 与 renderCompleted（chat-view.tsx）共享角色/符号/着色约定，但输出纯文本（给 less -R 解析）。
// 关键差异：工具结果取**完整 content**，不走 tool-panel 的 foldContent 裁剪——
// pager 存在的意义就是让用户看到折叠后丢失的完整长输出。
// 详见 docs/20260806230000_工具折叠-详设.md §5.2。
import { T, SYMBOLS } from './theme.js';
import { summarizeArg } from './tool-panel.js';
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

/** 单条消息 → 转录行块（角色/符号对齐 renderCompleted）。 */
function messageToLines(msg: DisplayMessage): string {
  switch (msg.kind) {
    case 'user':
      return `${color(`${SYMBOLS.user} 你`, T.user, { bold: true })}\n${INDENT}${color(msg.text, T.muted)}`;
    case 'assistant':
      // markdown 源码原样输出（pager 看「发生了什么」，原文最真实；渲染态由主界面负责）
      return `${color(`${SYMBOLS.brand} ECode`, T.brand, { bold: true })}\n${INDENT}${msg.text}`;
    case 'tool': {
      const icon = msg.isError ? SYMBOLS.error : SYMBOLS.success;
      const iconHex = msg.isError ? T.error : T.success;
      const arg = summarizeArg(msg.name, msg.input);
      const title = `${color(icon, iconHex)} ${color(msg.name, T.tool)}${arg ? color(` (${arg})`, T.muted) : ''}`;
      const body = indentBlock(msg.content); // 完整 content，不 foldContent
      return body ? `${title}\n${body}` : title;
    }
    case 'warning':
      return color(`${SYMBOLS.warning} ${msg.text}`, T.warning);
    case 'error':
      return color(`${SYMBOLS.error} ${msg.text}`, T.error);
  }
}

/**
 * DisplayMessage[] → 带 ANSI 颜色的转录纯文本（pager/less 输入）。
 * 段间空行分隔；空数组返回空串（调用方据此判断「无内容不进 pager」）。
 */
export function sessionMessagesToTranscript(messages: DisplayMessage[]): string {
  return messages.map(messageToLines).join('\n\n');
}
