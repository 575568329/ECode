/**
 * ToolCallView 的纯逻辑（TUI 规范 §4.11）：聚合 + 摘要 + 折叠阈值。
 * 与渲染（.tsx）分离，便于单测。
 */

import type { ToolResultBlock, ToolUseBlock } from '../core/types.js'

export interface ToolCallEntry {
  use: ToolUseBlock
  result?: ToolResultBlock
}

export interface ToolSummary {
  name: string
  inputDigest: string
  status: 'running' | 'success' | 'error'
  bytes: number
  preview: string
  collapsed: boolean
}

/** 折叠阈值（字节），输出超过则默认折叠。呼应 §4.11。 */
export const FOLD_THRESHOLD = 200

/** 入参摘要：取 path / command / pattern 等关键字段。 */
export function inputDigest(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const obj = input as Record<string, unknown>
  return String(obj.path ?? obj.command ?? obj.pattern ?? '')
}

/** 输出首行预览（截断 80 字符）。 */
export function previewLine(content: string): string {
  return content.split('\n')[0]?.slice(0, 80) ?? ''
}

/** 单个工具调用摘要。 */
export function summarize(entry: ToolCallEntry): ToolSummary {
  const content = entry.result?.content ?? ''
  const bytes = Buffer.byteLength(content, 'utf8')
  return {
    name: entry.use.name,
    inputDigest: inputDigest(entry.use.input),
    status: entry.result == null ? 'running' : entry.result.is_error ? 'error' : 'success',
    bytes,
    preview: previewLine(content),
    collapsed: bytes > FOLD_THRESHOLD,
  }
}

/** 同工具名聚合（保持首次出现顺序）。呼应 §4.11「同轮同工具聚合」。 */
export function groupByName(entries: ToolCallEntry[]): Map<string, ToolCallEntry[]> {
  const groups = new Map<string, ToolCallEntry[]>()
  for (const e of entries) {
    const arr = groups.get(e.use.name)
    if (arr) arr.push(e)
    else groups.set(e.use.name, [e])
  }
  return groups
}
