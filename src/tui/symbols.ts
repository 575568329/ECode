/**
 * TUI 符号（Unicode，TUI 规范 §2.2）。
 * 退化方案（ASCII）见 TUI 规范 §8——终端不支持 Unicode 时降级。
 */

export const symbols = {
  prompt: '❯', // 输入提示符
  tool: '⚫', // 工具调用标记（Wide 宽 2，避免中文终端 ambiguous=2 错位）
  success: '✓', // 成功
  error: '✗', // 失败
  warn: '⚠', // 警告
  foldCollapsed: '▸', // 折叠（未展开）
  foldExpanded: '▾', // 折叠（已展开）
  trunc: '…', // 截断
} as const

export type Symbols = typeof symbols
