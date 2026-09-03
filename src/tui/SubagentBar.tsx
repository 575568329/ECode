/**
 * 子代理进度行（M11-P4）：动态区每运行中子代理恒 1 行；超上限 3 折叠为合计行（D9 定值）。
 * 数据源：subagent.ts 模块级进度桥（setSubagentProgressHandler 推送快照）。
 * 不与父抢 ActivityBar/StatusBar（方案 §1.5：onActivity/onIter 不配，可见性由此承担）。
 * 2026-09-03 拍板：行内只显示**总时长**（startedAt 起算）——阶段耗时（waitingSince）不进
 * 折叠行，Ctrl+T transcript 展开里看事件行时刻差。
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

/** 秒数 → m:ss（子代理无 10min 硬超时后可长跑，h:mm:ss 兜底） */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, totalSec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export function SubagentBar({ agents }: { agents: SubagentStatus[] }): ReactElement | null {
  // 总时长逐秒递增：1s 自持节拍仅代理可见时跑（TasksBar 轮询同款模式）——状态推送是
  // 事件驱动（工具开跑/返回），秒数走本地时钟换算（startedAt），不靠事件驱动
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
    // 审阅修复批（功能席 P1-2）：合计行宽度账——names 与「· 最久 dur」并入**同一个
    // clipWidth**（原 names 单独 clip 只扣 28 列，尾段 h:mm:ss 实测最宽 ~14 列超账 → wrap
    // 折 2 物理行使 allocateDynamic 预算失效——TasksBar P1-7 同族纪律）。截断保头部
    // （前 3 个名字开头），整行恒 1 物理行
    const names = agents.slice(0, MAX_LINES).map((a) => a.description).join(' · ')
    const elapsed = agents.map((a) => (a.startedAt !== undefined ? Math.round((now - a.startedAt) / 1000) : -1))
    const oldest = Math.max(...elapsed)
    // startedAt 全缺（旧 daemon 帧混跑）不显示「最久 0:00」假值——单行路径同口径
    const tail = oldest >= 0 ? `（${names}… · 最久 ${formatDuration(oldest)}）` : `（${names}…）`
    const head = `${symbols.tool} ${agents.length} 个子代理运行中`
    return (
      <Box paddingLeft={1}>
        <Text color={theme.info}>
          {head}
          <Text dimColor> {clipWidth(tail, Math.max(10, maxLine - stringWidth(head)))}</Text>
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {agents.map((a) => {
        const desc = clipWidth(`「${a.description}」`, Math.max(10, Math.floor(maxLine * 0.5)))
        const elapsed = a.startedAt !== undefined ? ` · ${formatDuration(Math.round((now - a.startedAt) / 1000))}` : ''
        const suffix = clipWidth(` · ${a.activity}${elapsed}`, Math.max(10, maxLine - 4 - stringWidth(desc)))
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
