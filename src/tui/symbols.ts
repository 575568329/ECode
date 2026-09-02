/**
 * TUI 符号（Unicode，TUI 规范 §2.2）。
 * 退化方案（ASCII）见 TUI 规范 §8——终端不支持 Unicode 时降级。
 */

export const symbols = {
  prompt: '❯', // 输入提示符
  tool: '●', // 工具调用标记（U+25CF；配 ToolCallView minWidth=2 锁宽，不依赖字符宽度判定）
  // 活动流 D11（2026-09-02 拍板「按类型」）：工具行按类型图标（ZCode 同款信息密度）；
  // ASCII 退化映射位（规范 §8——运行时开关挂真机门，此处集中定义防散落）
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
} as const

export type Symbols = typeof symbols

/** D11 按类型工具图标（终端/编辑/查阅三分法；其余工具统一 ●） */
export function toolIcon(name: string): string {
  if (name === 'bash') return symbols.toolTerminal
  if (name === 'edit_file' || name === 'write_file') return symbols.toolEdit
  if (name === 'read_file' || name === 'glob' || name === 'grep') return symbols.toolRead
  return symbols.tool
}

/** ASCII 退化映射（规范 §8 退化位；运行时开关挂真机门验证字形后再接） */
export const asciiFallback: Record<string, string> = {
  '●': '*',
  '▢': '[',
  '✎': 'e',
  '⌕': 'f',
  '✻': '*',
  '▲': '^',
}
