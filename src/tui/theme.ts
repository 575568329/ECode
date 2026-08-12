/**
 * TUI 配色（适度色彩，暗色主题，TUI 规范 §2.1）。
 * Ink <Text color> 用颜色名。集中管理便于后续主题切换（亮/暗）。
 */

export const theme = {
  user: 'gray', // 用户消息（灰）
  assistant: 'white', // 助手文本（默认白）
  tool: 'cyan', // 工具名（青·明显）
  success: 'green', // ✓ 成功
  error: 'red', // ✗ 错误
  warn: 'yellow', // ⚠ 警告
  dim: 'gray', // 次要（输出预览/折叠提示/字节数）
  status: 'blue', // 状态栏
  activity: 'cyan', // ActivityBar spinner
} as const

export type Theme = typeof theme
