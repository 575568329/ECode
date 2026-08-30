/**
 * W-4 diff 展示纯逻辑（批 3）：把工具结果里的 unified diff 解析为可着色的行模型。
 * 输入形态与 TUI 一致：`已更新 <path>（N 处）\n\n--- a\n+++ b\n@@ ...`（edit_file/write_file 结果）。
 * 解析失败/无 diff 返回 null（调用方回退普通 pre 展示）——展示物不允许致命。
 */

export interface DiffLineView {
  kind: 'meta' | 'file' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
}

export interface DiffView {
  /** diff 正文前的说明行（如「已更新 a.ts（1 处）」）——调用方可自选渲染 */
  header: string
  lines: DiffLineView[]
  /** 解析出的变更行数（+/−），用于超长截断提示 */
  changes: number
  /** 传入内容是否被截断（超 MAX_DIFF_LINES） */
  truncated: boolean
  /** 截断后丢弃的行数 */
  omitted: number
}

/** 展示上限：超过即截断并提示（真实 diff 极少超过；防病态输入拖死 DOM） */
export const MAX_DIFF_LINES = 2000

function classify(line: string): DiffLineView['kind'] {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/**
 * 解析工具结果 → diff 视图模型。
 * - 首个空行前的非空首行视为说明头（「已更新 xxx（N 处）」）；
 * - `---`/`+++`/`@@` 起始处进入 diff 正文；
 * - 找不到 diff 标记 → null（调用方回退 pre）。
 */
export function parseDiffContent(content: string): DiffView | null {
  if (content === '') return null
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  // 定位 diff 正文起点：首个 --- 行（jsdiff 头两行 --- / +++）
  const start = lines.findIndex((l) => l.startsWith('--- '))
  if (start === -1) return null
  const header = lines.slice(0, start).filter((l) => l.trim() !== '').join('\n')
  const body = lines.slice(start)
  if (body.length === 0) return null
  const truncated = body.length > MAX_DIFF_LINES
  const shown = truncated ? body.slice(0, MAX_DIFF_LINES) : body
  const out: DiffLineView[] = shown.map((text) => ({ kind: classify(text), text }))
  return {
    header,
    lines: out,
    changes: out.filter((l) => l.kind === 'add' || l.kind === 'del').length,
    truncated,
    omitted: truncated ? body.length - MAX_DIFF_LINES : 0,
  }
}
