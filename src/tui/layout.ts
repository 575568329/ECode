/**
 * TUI 排版常量表（排版批 ②，layout.md 差距清单五维收敛）。
 *
 * 此前缩进/间距/宽度三套口径散在 Markdown.tsx / ToolGroupView.tsx /
 * Conversation.tsx 里（工具块 3、引用块 2、正文 0——「乱」的根源）。
 * 本模块是全 TUI 排版常量的唯一出处：改排版只改这里，引用处不写裸数字。
 *
 * 栅格模型（对齐 CC MessageResponse 模式）：
 *   工具行本体缩进 0（loader 占 2 列，minWidth 锁宽）；
 *   子内容（工具输出/preview/折叠提示）排在 gutter 右侧的内容列：
 *     gutter  = "  ⎿  "（5 列：2 空 + ⎿ + 2 空）——⎿ 及其两侧空格
 *     content = 5（内容列起始 = gutter 宽，续行经 wrap 宽度约束自动对齐 ⎿ 下方 = 悬挂缩进）
 *   块与块之间恒隔 GAP.block=1 空行（Markdown 块内 gap 同值）。
 */

/** 缩进（列数） */
export const INDENT = {
  /** 工具行 loader 图标列宽（minWidth 锁宽，不随字符宽度漂移） */
  icon: 2,
  /** gutter 总宽（2 空 + ⎿ + 2 空）——工具块子内容悬挂缩进列 */
  gutter: 5,
  /** 内容列起始列 = gutter 宽（续行对齐 ⎿ 下方） */
  content: 5,
  /** thinking / 引用块 / 列表每层缩进 */
  sub: 2,
} as const

/** 块间距（行数）——块与块之间恒 1 空行（CC `marginTop={addMargin?1:0}` 同节奏） */
export const GAP = {
  block: 1,
} as const

/** 宽度公式归一（列数）——三套口径（min(cols,100) / columns-6 / columns-14）收敛于此 */
export const WIDTH = {
  /** 正文（markdown）内容宽上限：终端宽与 100 取小 */
  contentMax: 100,
  /** 正文实际宽 = min(columns, contentMax) */
  content: (columns: number): number =>
    Math.min(columns > 0 ? columns : 80, WIDTH.contentMax),
  /** 工具输出内容宽 = columns - gutter - 余量（CC terminalWidth-10 同思路：扣减=缩进占用） */
  toolOutputReserve: 10,
  toolOutput: (columns: number): number =>
    Math.max(10, (columns > 0 ? columns : 80) - WIDTH.toolOutputReserve),
  /** 工具名串截断宽 = columns - icon - 余量（表头名列表 clip 收口） */
  toolNamesReserve: 14,
  toolNames: (columns: number): number =>
    Math.max(12, (columns > 0 ? columns : 80) - WIDTH.toolNamesReserve),
} as const
