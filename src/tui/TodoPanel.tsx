/**
 * 任务清单常驻面板（2026-08-30 对标改造）：挂在输入区上方，显示最新整表——
 * 三家对标共识（CC/harness/opencode）：todo 清单不进对话流（CC 官方注释 "TodoWrite
 * updates the todo panel, not the transcript"），opencode 默认展开形态最贴合
 * 「清单内容直接可见」诉求。数据源=最近一次 todo 工具调用的 input（消息即状态，
 * M11 v1.2 拍板沿用——不引额外 Store，从 committed/active 派生）。
 * 渲染沿用 M11-P6 的 ASCII 状态符体系（[x]/[->]/[ ]——ambiguous 宽度教训只用 ASCII）。
 */
import { Box, Text } from 'ink'
import { theme } from './theme.js'

export interface TodoEntry {
  content: string
  status: string
}

/** 超屏防御：清单超过此数截断（CC TaskListV2 同款思路——面板常驻不能无限占行）。
 *  导出供 TuiApp 派生 todoLines 预算（allocateDynamic 条件段同源，审阅 P0-2） */
export const TODO_MAX_VISIBLE = 12

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
  const shown = todos.length > maxVisible ? todos.slice(0, maxVisible) : todos
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
              {x.status === 'completed' ? '[x] ' : x.status === 'in_progress' ? '[->] ' : '[ ] '}
              {x.content}
            </Text>
          ))}
          {todos.length > maxVisible && <Text dimColor>…还有 {todos.length - maxVisible} 项</Text>}
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
