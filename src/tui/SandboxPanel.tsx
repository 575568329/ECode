/**
 * /sandbox 面板（M9-P4/D13/D12）：四档列表，Tab/↑↓ 循环，Enter 选定。
 * full-access 二级确认（切档防误触——全免确认是危险态；内置黑名单与 blockedCommands 仍硬拒）。
 * Tab 在面板内专职循环切档（M9-D13）；Esc 取消。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'
import { SANDBOX_MODES, type SandboxMode } from '../services/sandbox.js'

/** 各档一行说明（软沙箱诚实边界：bash 无法可靠解析写目标，read-only 整体拒绝、其余确认兜底） */
const MODE_DESC: Record<SandboxMode, string> = {
  default: '写文件/bash 每次确认（现状）；无越界分流',
  'read-only': 'write/edit/bash 全部拒绝；读类照常',
  'workspace-write': '写/改仅限工作目录内（越界直接拒绝，拦 .. 逃逸）；bash 每次确认',
  'full-access': '全部免确认（危险）；内置黑名单与 blockedCommands 仍硬拒',
}

interface SandboxPanelProps {
  current: SandboxMode
  /** 选定生效（含 full-access 确认后）；null = 取消 */
  onPick: (mode: SandboxMode | null) => void
}

export function SandboxPanel({ current, onPick }: SandboxPanelProps): ReactElement {
  const [idx, setIdx] = useState(() => Math.max(0, SANDBOX_MODES.indexOf(current)))
  const [confirming, setConfirming] = useState(false)

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y' || key.return) onPick('full-access')
      else if (key.escape) setConfirming(false)
      return
    }
    const cycle = (dir: 1 | -1): void => {
      setIdx((i) => (i + dir + SANDBOX_MODES.length) % SANDBOX_MODES.length)
    }
    if (key.tab && !key.shift) cycle(1) // Tab 专职：循环下移（M9-D13）
    else if (key.upArrow) cycle(-1)
    else if (key.downArrow) cycle(1)
    else if (key.return) {
      const mode = SANDBOX_MODES[idx]
      if (mode === 'full-access' && current !== 'full-access') setConfirming(true)
      else onPick(mode ?? null)
    } else if (key.escape) onPick(null)
  })

  if (confirming) {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.error} paddingX={1}>
        <Text color={theme.error} bold> ⚠ 进入 full-access？</Text>
        <Box marginTop={1}>
          <Text dimColor>
            {' '}全部工具免确认执行；仅内置八条危险黑名单与 sandbox.blockedCommands 仍硬拒。
            确信当前任务可信再继续。
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor> y 确认进入 · Esc 返回</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold> 沙箱档位（Tab 循环切换，当前会话生效不落盘）</Text>
      <Box flexDirection="column" marginTop={1}>
        {SANDBOX_MODES.map((m, i) => {
          const selected = i === idx
          const isCurrent = m === current
          return (
            <Text key={m} inverse={selected} bold={selected} color={m === 'full-access' && !selected ? theme.error : undefined}>
              {' '}
              {m}
              {isCurrent ? '  (当前)' : ''}
              {!selected ? <Text dimColor> —— {MODE_DESC[m]}</Text> : ` —— ${MODE_DESC[m]}`}
            </Text>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor> Tab/↑↓ 循环 · 回车 选定 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
