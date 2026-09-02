/**
 * TUI 符号（Unicode，TUI 规范 §2.2）。
 * 退化方案（ASCII）见 TUI 规范 §8——ECODE_ASCII_SYMBOLS=1 显式启用（零探测成本，
 * 失败可优雅降级；字形覆盖验证归真机门）。
 */

/** ASCII 退化映射（规范 §8 退化位） */
const asciiFallback: Record<string, string> = {
  '●': '*',
  '◆': '>',
  '▢': '[',
  '✎': 'e',
  '⌕': 'f',
  '✻': '*',
  '▲': '^',
}

const GLYPHS = {
  prompt: '❯', // 输入提示符
  tool: '●', // 工具调用标记（U+25CF；图标槽 minWidth=2 锁宽，不依赖字符宽度判定）
  // 活动流 D11（2026-09-02 拍板「按类型」）：工具行按类型图标（ZCode 同款信息密度）
  toolTerminal: '▢',
  toolEdit: '✎',
  toolRead: '⌕',
  success: '✓', // 成功
  error: '✗', // 失败
  warn: '⚠', // 警告
  foldCollapsed: '▸', // 折叠（未展开）
  foldExpanded: '▾', // 折叠（已展开）
  trunc: '…', // 截断
  thinking: '✻', // 思考行（活动流 D4-B；U+273B）
  folded: '▲', // 折叠摘要行（活动流 §5.5.3）
  assistant: '◆', // 助手正文行（活动流 D3 二次翻案 2026-09-02：用户观感拍板正文加图标——
  // 原顶格与后续工具行黏连难分；◆ 与 ●/▢ 同属几何图形区字形覆盖稳，避免与工具行 ● 混淆）
} as const

/** 对外符号表（ASCII 开启时逐符号查表退化；无映射的保持原样） */
export const symbols: typeof GLYPHS =
  process.env.ECODE_ASCII_SYMBOLS === '1'
    ? (Object.fromEntries(
        Object.entries(GLYPHS).map(([k, v]) => [k, asciiFallback[v as string] ?? v]),
      ) as typeof GLYPHS)
    : GLYPHS

export type Symbols = typeof symbols

/** D11 按类型工具图标（终端/编辑/查阅三分法；其余工具统一 ●） */
export function toolIcon(name: string): string {
  if (name === 'bash') return symbols.toolTerminal
  if (name === 'edit_file' || name === 'write_file') return symbols.toolEdit
  if (name === 'read_file' || name === 'glob' || name === 'grep') return symbols.toolRead
  return symbols.tool
}
