/**
 * 子代理进度行（M11-P4）：动态区每运行中子代理恒 1 行；超上限 3 折叠为合计行（D9 定值）。
 * 数据源：subagent.ts 模块级进度桥（setSubagentProgressHandler 推送快照）。
 * 不与父抢 ActivityBar/StatusBar（方案 §1.5：onActivity/onIter 不配，可见性由此承担）。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { clipWidth } from './viewport.js'
import type { SubagentStatus } from '../services/subagent.js'

/** 折叠为合计行的阈值（方案 D9 v1.4 定值：超屏预算体系不建，直接定常数） */
const MAX_LINES = 3

export function SubagentBar({ agents }: { agents: SubagentStatus[] }): ReactElement | null {
  // 等待期秒数递增（activity=思考中/启动中时）：1s 自持节拍仅代理可见时跑（TasksBar 轮询同款模式）——
  // 状态本身只在工具开跑/返回时推送，秒数走本地时钟换算（waitingSince），不靠事件驱动
  const [, setTick] = useState(0)
  useEffect(() => {
    if (agents.length === 0) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [agents.length])
  // 审阅 P2：长描述/activity wrap 会使 allocateDynamic「各 ≤3 行」预留翻倍——按列宽截断
  const maxLine = Math.max(20, process.stdout.columns ?? 80)
  if (agents.length === 0) return null
  const now = Date.now()
  if (agents.length > MAX_LINES) {
    const names = clipWidth(agents.slice(0, MAX_LINES).map((a) => a.description).join(' · '), maxLine - 20)
    return (
      <Box paddingLeft={1}>
        <Text color={theme.info}>{symbols.tool} {agents.length} 个子代理运行中</Text>
        <Text dimColor>（{names}…）</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {agents.map((a) => {
        const desc = clipWidth(`「${a.description}」`, Math.max(10, Math.floor(maxLine * 0.5)))
        const suffix = clipWidth(
          ` · ${a.activity}${a.waitingSince !== undefined ? ` ${Math.max(0, Math.round((now - a.waitingSince) / 1000))}s` : ''}`,
          Math.max(10, maxLine - 4 - stringWidth(desc)),
        )
        return (
          <Box key={a.id} paddingLeft={1}>
            <Text color={theme.info}>{symbols.tool} {desc}</Text>
            <Text dimColor>{suffix}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
