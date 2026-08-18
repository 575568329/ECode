/**
 * 子代理进度行（M11-P4）：动态区每运行中子代理恒 1 行；超上限 3 折叠为合计行（D9 定值）。
 * 数据源：subagent.ts 模块级进度桥（setSubagentProgressHandler 推送快照）。
 * 不与父抢 ActivityBar/StatusBar（方案 §1.5：onActivity/onIter 不配，可见性由此承担）。
 */

import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import type { SubagentStatus } from '../services/subagent.js'

/** 折叠为合计行的阈值（方案 D9 v1.4 定值：超屏预算体系不建，直接定常数） */
const MAX_LINES = 3

export function SubagentBar({ agents }: { agents: SubagentStatus[] }): ReactElement | null {
  if (agents.length === 0) return null
  if (agents.length > MAX_LINES) {
    const names = agents.slice(0, MAX_LINES).map((a) => a.description).join(' · ')
    return (
      <Box paddingLeft={1}>
        <Text color={theme.info}>{symbols.tool} {agents.length} 个子代理运行中</Text>
        <Text dimColor>（{names}…）</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {agents.map((a) => (
        <Box key={a.id} paddingLeft={1}>
          <Text color={theme.info}>{symbols.tool} 「{a.description}」</Text>
          <Text dimColor> · {a.activity}</Text>
        </Box>
      ))}
    </Box>
  )
}
