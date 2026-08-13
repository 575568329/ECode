/**
 * 流式灰字折叠（M2 方案 A，第 2b 步 / TUI 规范 §4.12）。
 *
 * 流式期灰字占位超过阈值行数时，只显示**尾部 N 行**（最新生成，用户看当前输出）
 * + 顶部提示折叠掉的行数，避免长输出占满动态区挡住历史。commit 后 Markdown 全量重渲染。
 */

/** 流式灰字最多显示的行数（尾部）；最小 Static 方案压到 3（详设 §3） */
export const STREAM_MAX_LINES = 3

export interface FoldedStream {
  /** 实际显示的行（尾部 maxLines 行，或全部） */
  lines: string[]
  /** 被折叠掉的行数（头部），0 表示未折叠 */
  folded: number
  /** 总行数 */
  total: number
}

/**
 * 把流式文本折叠成尾部 N 行 + 折叠计数。
 * 行按 `\n` 切分；不超过 maxLines 时原样返回。
 */
export function foldStreamText(text: string, maxLines: number = STREAM_MAX_LINES): FoldedStream {
  const allLines = text.split('\n')
  const total = allLines.length
  if (total <= maxLines) {
    return { lines: allLines, folded: 0, total }
  }
  return {
    lines: allLines.slice(total - maxLines),
    folded: total - maxLines,
    total,
  }
}
