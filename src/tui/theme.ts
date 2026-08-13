/**
 * TUI 配色（适度色彩，暗色主题，TUI 规范 §2.1）。
 * Ink <Text color> 用颜色名。集中管理便于后续主题切换（亮/暗）。
 */

/**
 * 配色（克制语义色板，调研 Claude Code/opencode：1 强调色 + 3 语义色 + 灰阶，砍 *Bright）。
 * 用 RGB 字面量（避免用户终端 ANSI 自定义导致不一致，呼应 Claude Code theme.ts）。
 */
export const theme = {
  user: '#E6E6E6', // 用户消息文字（亮，不灰；靠 userBg 背景块区分）
  assistant: '#E6E6E6', // 助手正文
  tool: '#ffffff', // 工具名（白色）
  success: '#7FD88F', // ✓ 成功（柔和绿）
  error: '#E06C75', // ✗ 错误（柔和红）
  warn: '#E5C07B', // ⚠ 警告（暖黄，不刺眼）
  dim: '#808080', // 次要灰（预览/字节数/折叠提示）
  status: '#5C9CF5', // StatusBar（蓝）
  activity: '#F5A742', // ActivityBar spinner（accent）
  userBg: '#282828', // 用户消息背景块
  border: '#3C3C3C', // 分隔线/边框
  info: '#5C9CF5', // 链接/提示符
  errorBg: '#3a2020', // diff 删除行背景（暗红）
  successBg: '#1e3020', // diff 新增行背景（暗绿）
} as const

export type Theme = typeof theme
