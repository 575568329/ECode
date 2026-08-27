import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ConfirmState } from './types.js'
import { theme } from './theme.js'
import { DiffLine } from './DiffLine.js'
import { ROWS_FALLBACK, computeBudget, sectionBudget, useViewport } from './viewport.js'

/**
 * 确认弹窗（详设 §7.3）：副作用工具执行前给用户决策。
 *
 * 交互：
 * - ← →：在「执行 / 取消」间切换（默认选中「执行」）
 * - 回车：确认当前选中（默认直接回车 = 执行）
 * - y/n：快捷键直接确认（兼容老习惯）
 * - Ctrl+C：取消该工具（P0#1：useInterrupt 守卫不抢）
 *
 * 展示：
 * - edit_file：unified diff（按行着色：- 红 / + 绿 / @@ 蓝 / --- +++ 加粗）
 * - write_file：content 片段（灰）
 * - bash：完整命令（灰）
 *
 * 高度感知截断：动态区 outputHeight ≥ 视口行数会触发 Ink fullscreen（视角被顶到
 * 顶部、scrollback 被清，用户无法下拉）——preview 行数必须按终端行数封顶
 * （edit_file 大 diff 无数据层上限，此处是唯一防线）。非 TTY（测试 pipe）rows
 * 未知 → 兜底 24。
 *
 * y/n/回车后组件由父卸载（active.confirm=null），不残留动态区。
 */

/** 预留（相对 budget=rows−2；原 rows−17 换算）= 弹窗骨架 7（marginTop×3+边框 2+标题 1+
 * 选项 1）+ 弹窗时动态区共存 9（折叠用户输入 3 + 折叠工具组 4 + ActivityBar/状态行/输入行 3）
 * + 余量 1。审阅实测推导——Ink 是 >= 判定，恰好占满也触发 fullscreen，低估 1 行就破防。 */
const PREVIEW_RESERVE = 15
/** 极矮终端保命线：preview 至少留 5 行（头 3 + 省略 1 + 尾 1） */
const PREVIEW_MIN_LINES = 5

/** preview 可见行上限 = 帧高预算 − 预留（M14-V1 收敛 viewport 公式；导出供单测锁
 * rows 路径；渲染组合由 ink-testing 用例覆盖兜底路径） */
export function previewMaxLines(rows: number | undefined): number {
  return Math.max(PREVIEW_MIN_LINES, sectionBudget(computeBudget(rows ?? ROWS_FALLBACK), PREVIEW_RESERVE))
}

/** 超高 preview 保头尾截断：头 2/3（diff 文件名/hunk 定位）+ 省略计数 + 尾 1/3（最近改动） */
export function clampPreviewLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines
  const head = Math.max(2, Math.ceil(((max - 1) * 2) / 3))
  const tail = max - 1 - head
  const omitted = lines.length - head - tail
  return [
    ...lines.slice(0, head),
    `⋯ 省略 ${omitted} 行（共 ${lines.length} 行）`,
    ...lines.slice(lines.length - tail),
  ]
}

interface ConfirmPromptProps {
  state: ConfirmState
  /** 清 active.confirm（父卸载本组件） */
  onConfirm?: () => void
  onCancel?: () => void
}

export function ConfirmPrompt({ state, onConfirm, onCancel }: ConfirmPromptProps): ReactElement {
  const input = state.use.input as Record<string, unknown>
  const target = String(input.path ?? input.command ?? '')
  const isDiff = state.use.name === 'edit_file'
  // 第三键（remember）：MCP=「本会话记住」（v3 P1-3 server 级放行）；M9-P5 权限=「永久记住」（rememberLabel 通用化）
  const rememberText = state.rememberLabel ?? (state.use.name.startsWith('mcp__') ? '本会话记住' : undefined)
  const isMcp = rememberText !== undefined
  // 默认选中「执行」（y）—— 直接回车就继续，符合「确认优先」直觉
  const [selected, setSelected] = useState<'y' | 'n' | 'a'>('y')
  const { rows } = useViewport()
  const previewLines = clampPreviewLines(state.preview.split('\n'), previewMaxLines(rows))

  const decide = (ok: boolean, always = false) => {
    state.resolve(ok, always)
    if (ok) onConfirm?.()
    else onCancel?.()
  }

  useInput((inputChar, key) => {
    if (key.leftArrow || key.rightArrow) {
      // 三选项循环（y → n → a → y；非 MCP 只有 y/n）
      setSelected((s) => (s === 'y' ? 'n' : s === 'n' ? (isMcp ? 'a' : 'y') : 'y'))
    } else if (inputChar === 'y') {
      decide(true)
    } else if (inputChar === 'n') {
      decide(false)
    } else if (inputChar === 'a' && isMcp) {
      decide(true, true)
    } else if (key.return) {
      if (selected === 'a') decide(true, true)
      else decide(selected === 'y')
    } else if (key.ctrl && inputChar === 'c') {
      decide(false)
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Box>
        <Text color={theme.warn} bold>
          ⚠ 执行 {state.use.name}?
        </Text>
        {target !== '' && <Text> {target}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {isDiff
          ? previewLines.map((line, i) => (
              <Box key={i}>
                <DiffLine line={line} />
              </Box>
            ))
          : <Text dimColor>{previewLines.join('\n')}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text inverse={selected === 'y'} bold={selected === 'y'}>
          {' [y] 执行 '}
        </Text>
        <Text>   </Text>
        <Text inverse={selected === 'n'} bold={selected === 'n'}>
          {' [n] 取消 '}
        </Text>
        {isMcp && (
          <>
            <Text>   </Text>
              <Text inverse={selected === 'a'} bold={selected === 'a'} color="green">
              {` [a] ${rememberText} `}
            </Text>
          </>
        )}
        <Text dimColor>   ← →选择 · 回车确认 · Ctrl+C 取消{isMcp ? ` · a=${rememberText}` : ''}</Text>
      </Box>
    </Box>
  )
}
