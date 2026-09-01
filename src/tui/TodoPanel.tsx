/**
 * 任务清单常驻面板（2026-08-30 对标改造）：挂在输入区上方，显示最新整表——
 * 三家对标共识（CC/harness/opencode）：todo 清单不进对话流（CC 官方注释 "TodoWrite
 * updates the todo panel, not the transcript"），opencode 默认展开形态最贴合
 * 「清单内容直接可见」诉求。数据源=最近一次 todo 工具调用的 input（消息即状态，
 * M11 v1.2 拍板沿用——不引额外 Store，从 committed/active 派生）。
 * 状态符（用户真机反馈 [x] 读作「失败叉」）：✓ 完成（成功绿）/ ▸ 进行中 / ○ 待办。
 * 弃用 M11-P6 的 ASCII 体系（[x]/[->]/[ ]）——清晰度优先；符号仅在行首独立使用，
 * 无跨列对齐面，ambiguous 宽度终端下至多本行文字偏移 1 列（可接受）。
 */
import { Box, Text } from 'ink'
import { theme } from './theme.js'

export interface TodoEntry {
  content: string
  status: string
}

/** 超屏防御：清单超过此数截断（用户拍板 3 项——输入区上方空间珍贵，完成的排尾优先折叠）。
 *  导出供 TuiApp 派生 todoLines 预算（allocateDynamic 条件段同源，审阅 P0-2） */
export const TODO_MAX_VISIBLE = 3

/** 显示排序：进行中 > 待办 > 已完成（稳定排序，组内保持原顺序）——
 *  超 3 项折叠时先折已完成的，未完成项永不被折（用户拍板） */
const STATUS_RANK: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 }

export function TodoPanel({
  todos,
  altMode,
  maxVisible = TODO_MAX_VISIBLE,
}: {
  todos: TodoEntry[] | null
  altMode?: boolean
  /** 预算收口（allocateDynamic degraded 时传 0 隐藏——极小终端宁可整面板不显示也不 3J） */
  maxVisible?: number
}): React.JSX.Element | null {
  if (altMode || todos === null || todos.length === 0 || maxVisible <= 0) return null
  const done = todos.filter((x) => x.status === 'completed').length
  // 全部完成 → 整面板自动收起（用户真机反馈：完成后常驻像没清场；对标 CC——清单服务执行期，
  // 收尾即退役。transcript 里 ✓ 历史仍在，新任务建新清单时面板自然重现）
  if (done === todos.length) return null
  const sorted = [...todos].sort((a, b) => (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1))
  const shown = sorted.length > maxVisible ? sorted.slice(0, maxVisible) : sorted
  // 折叠的全是已完成时明说（未完成 > 上限时仍是普通折叠——3 的硬上限使然）
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Box minWidth={2}>
          <Text dimColor>◆</Text>
        </Box>
        <Text bold dimColor>
          任务清单{' '}
        </Text>
        <Text dimColor>
          {done}/{todos.length} 完成
        </Text>
      </Box>
      <Box>
        <Box minWidth={2} />
        <Box flexDirection="column">
          {shown.map((x, i) => (
            <Text key={i} color={x.status === 'in_progress' ? theme.info : undefined} bold={x.status === 'in_progress'} dimColor={x.status === 'completed'}>
              {x.status === 'completed' ? '✓ ' : x.status === 'in_progress' ? '▸ ' : '○ '}
              {x.content}
            </Text>
          ))}
          {todos.length > maxVisible && (
            <Text dimColor>
              …还有 {todos.length - maxVisible} 项
              {sorted.slice(maxVisible).every((x) => x.status === 'completed') ? '（均已完成）' : ''}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}

/** 从 CommittedItem[]/ActiveTool 混合源派生最新 todo 清单（倒序找最近一次 todo 调用）。 */
export function deriveLatestTodos(sources: Array<{ name: string; use?: { input?: unknown } }>): TodoEntry[] | null {
  for (let i = sources.length - 1; i >= 0; i--) {
    const t = sources[i]
    if (t.name === 'todo' && t.use !== undefined) {
      const todos = (t.use.input as { todos?: TodoEntry[] }).todos
      if (Array.isArray(todos) && todos.length > 0) return todos
    }
  }
  return null
}
