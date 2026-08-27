/**
 * 任务状态行（M14 §3.5，V3）：运行中后台任务在 ActivityBar 上方常驻 ≤3 行
 * （照 SubagentBar 折叠模式）——零操作知道"还活着、在干什么"。
 * 数据源：taskRegistry 模块单例快照 + 2s 轮询（日志尾行仅 mtime 变化时重读）。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { readFileSync, statSync } from 'node:fs'
import { theme } from './theme.js'
import { taskRegistry } from '../services/tasks.js'

/** 常驻行上限（与 SubagentBar MAX_LINES 同款定值；超限折叠为合计行） */
const MAX_LINES = 3

/** 日志尾行缓存（path → {mtime, lastLine}——mtime 不变不重读） */
const tailCache = new Map<string, { mtime: number; last: string }>()

function lastLineOf(path: string): string {
  try {
    const m = statSync(path).mtimeMs
    const hit = tailCache.get(path)
    if (hit !== undefined && hit.mtime === m) return hit.last
    const text = readFileSync(path, 'utf8')
    const lines = text.replace(/\n$/, '').split('\n')
    const last = (lines[lines.length - 1] ?? '').slice(0, 60)
    tailCache.set(path, { mtime: m, last })
    return last
  } catch {
    return ''
  }
}

export function TasksBar(): ReactElement | null {
  const [running, setRunning] = useState(() => taskRegistry.snapshot().filter((t) => t.status === 'running'))
  useEffect(() => {
    const timer = setInterval(() => setRunning(taskRegistry.snapshot().filter((t) => t.status === 'running')), 2000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])

  if (running.length === 0) return null
  if (running.length > MAX_LINES) {
    return (
      <Box paddingLeft={1}>
        <Text color={theme.info}>⏵ {running.length} 个后台任务运行中</Text>
        <Text dimColor>（{running
          .slice(0, MAX_LINES)
          .map((t) => t.command.slice(0, 24))
          .join(' · ')}… · /output 查看）</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {running.map((t) => {
        const tail = lastLineOf(t.outputFile)
        return (
          <Box key={t.id} paddingLeft={1}>
            <Text color={theme.info}>⏵ {t.id} {t.command.slice(0, 36)}</Text>
            <Text dimColor>
              {' '}
              {tail === '' ? '（暂无输出）' : tail} · /output 查看
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
