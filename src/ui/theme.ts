// UI 视觉系统中心 —— 配色 token + 符号常量（spec §8.1 / §8.2）。
// 组件只引 token 名，禁止裸 hex。视觉基准：ui-preview.tsx。

/** 17 个语义配色 token（Catppuccin Mocha 基底）。 */
export const T = {
  brand: '#4ECDC4',
  user: '#89B4FA',
  tool: '#F9E2AF',
  result: '#6C7086',
  success: '#A6E3A1',
  error: '#F38BA8',
  warning: '#FAB387',
  info: '#89B4FA',
  permission: '#FAB387',
  thinking: '#94E2D5',
  suggestion: '#7F849C',
  accent: '#89B4FA',
  muted: '#6C7086',
  border: '#45475A',
  userBg: '#313244', // 用户消息背景（角色区分，M3.5 Phase 1）
  toolBg: '#181825', // BlockTool 面板背景（深）
  toolBorder: '#313244', // BlockTool 左边框
  diffAdded: '#A6E3A1',
  diffRemoved: '#F38BA8',
  inverseText: '#1E1E2E',
} as const;

/** 单宽 Unicode 几何符号（禁用 emoji：跨终端字宽不一破坏对齐）。 */
export const SYMBOLS = {
  user: '❯',
  brand: '◆',
  tool: '▸',
  result: '↳',
  success: '✓',
  error: '✗',
  warning: '▲',
  thinking: '◐',
  prompt: '▶',
  todoPending: '◻',
  todoProgress: '◾',
  pointer: '›',
} as const;

/** braille spinner 帧序列（品牌色）。 */
export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
