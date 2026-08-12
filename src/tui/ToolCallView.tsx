import { useState } from 'react'
import type { ReactElement } from 'react'
import { Text, Box, useFocus, useInput } from 'ink'
import { summarize, type ToolCallEntry } from './toolview.js'
import { theme } from './theme.js'
import { symbols } from './symbols.js'

/**
 * 单个工具调用渲染（TUI 规范 §4.11 / M2 方案 B.3）：
 *
 *   [⏺] [工具名 bold 青] [inputDigest dim] [✓/✗]
 *      ▸ 输出首行… (折叠, 1.2KB)     ← 折叠态（默认：超 FOLD_THRESHOLD 折叠）
 *      ▾ 输出 (1.2KB)                ← 展开态
 *        <完整内容>
 *
 * - 纯逻辑（summarize/折叠阈值/聚合）来自 toolview.ts，已单测。
 * - running 态第一列 ⏺ dim（闪烁动画 + 共享时钟留第 3 步 ActivityBar）。
 * - 键盘交互（Enter toggle / Ctrl+O 全展）留第 2b 步；此处 expanded prop 受控预留。
 */

/** 字节数人类可读 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

interface ToolCallViewProps {
  entry: ToolCallEntry
  /** 受控展开（Ctrl+O 全展时传 true）；不传则内部自管 */
  expanded?: boolean
  /** 是否可交互（Tab 聚焦 + Enter toggle）；Static（已 commit）传 false */
  interactive?: boolean
}

export function ToolCallView({ entry, expanded, interactive = true }: ToolCallViewProps): ReactElement {
  const s = summarize(entry)
  const { isFocused } = useFocus({ id: entry.use.id, isActive: interactive })
  const [internalCollapsed, setInternalCollapsed] = useState(s.collapsed)
  const collapsed = expanded !== undefined ? !expanded : internalCollapsed
  const content = entry.result?.content ?? ''

  useInput(
    (_input, key) => {
      if (!isFocused) return
      if (key.return && expanded === undefined) {
        setInternalCollapsed((c) => !c)
      }
    },
    { isActive: interactive },
  )
  const hasOutput = content.length > 0

  // 第一列 ⏺ 颜色：running dim / error red / 其余工具色（cyan）
  const markColor =
    s.status === 'running' ? theme.dim : s.status === 'error' ? theme.error : theme.tool

  // 行尾状态符号（running 无，留 spinner 位）
  const tail: { sym: string; color: string } | null =
    s.status === 'success'
      ? { sym: symbols.success, color: theme.success }
      : s.status === 'error'
        ? { sym: symbols.error, color: theme.error }
        : null

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={markColor}>{symbols.tool}</Text>
        <Text bold color={theme.tool} inverse={isFocused}>
          {' '}
          {s.name}
        </Text>
        {s.inputDigest !== '' && <Text dimColor> {s.inputDigest}</Text>}
        {tail !== null && (
          <Text color={tail.color}> {tail.sym}</Text>
        )}
      </Box>
      {hasOutput && (
        <Box flexDirection="column" paddingLeft={3}>
          <Box>
            <Text dimColor>{collapsed ? symbols.foldCollapsed : symbols.foldExpanded}</Text>
            {collapsed ? (
              <Text dimColor>
                {' '}
                {s.preview}
                {content.length > s.preview.length
                  ? ` ${symbols.trunc}(${formatBytes(s.bytes)})`
                  : ''}
              </Text>
            ) : (
              <Text dimColor> 输出 ({formatBytes(s.bytes)})</Text>
            )}
          </Box>
          {!collapsed && (
            <Text color={s.status === 'error' ? theme.error : undefined}>{content}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}
