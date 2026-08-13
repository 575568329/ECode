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

/**
 * 工具合并块折叠态展示的最大工具数（详设 §3 超额策略）。
 * 折叠态 = 表头 1 + 摘要 MAX_TOOL_VISIBLE + 溢出提示 1 = ≤4 行，不随工具数增长。
 */
export const MAX_TOOL_VISIBLE = 2

/** mergeToolGroup 返回：合并块的展示数据。泛型 T 兼容 ToolCallEntry / ActiveTool。 */
export interface MergedToolGroup<T> {
  /** 工具总数 */
  count: number
  /** 折叠态可见的工具（前 MAX_TOOL_VISIBLE 个，展示摘要） */
  visible: T[]
  /** 溢出数（count - visible.length，>0 时显示「还有 N 个」） */
  overflow: number
}

/**
 * 把工具列表合并成一个展示块（详设 §3 超额策略）。
 * 折叠态恒 ≤4 行：表头 1 + visible 摘要（≤2）+ 溢出提示 1（有溢出时）。
 * 不随 count 增长——visible 封顶 MAX_TOOL_VISIBLE，超出转溢出计数。
 * 泛型：动态区传 ActiveTool[]，Static 测试传 ToolCallEntry[]。
 */
export function mergeToolGroup<T>(tools: T[]): MergedToolGroup<T> {
  const count = tools.length
  const visible = tools.slice(0, MAX_TOOL_VISIBLE)
  const overflow = Math.max(0, count - visible.length)
  return { count, visible, overflow }
}
