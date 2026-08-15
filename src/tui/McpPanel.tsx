/**
 * MCP 面板（M6 T3/M-P6）：`/mcp` 二级菜单——server 列表 → 详情（信息+操作）→ 工具列表。
 *
 * - 一级：状态着色 + 工具数；failed 且光标停行 → 错误自动展开（≤4 行，词级换行）
 * - ctrl+r：光标 server 快捷重连（乐观更新由 manager 状态事件驱动重渲染）
 * - 二级详情：查看工具 / 重连 / 断开（connecting 中断开=落地即关）/ 返回
 * - 三级：工具清单（只读，PanelShell 窗口滚动）
 * Esc 逐级回退（先清搜索词 → 退级 → 退出面板）。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { Select } from './Select.js'
import { theme } from './theme.js'
import type { McpServerSnapshot } from '../services/mcp/manager.js'

interface McpPanelProps {
  snapshots: McpServerSnapshot[]
  onReconnect: (name: string) => Promise<void>
  onDisconnect: (name: string) => Promise<void>
  onCancel: () => void
  /** 详情视图用：server 的工具清单名（manager 只在 snapshot 给数量；由调用方另给 defs） */
  toolsOf?: (serverName: string) => { name: string; description?: string }[]
}

type View = { view: 'list' } | { view: 'detail'; server: string } | { view: 'tools'; server: string }

/** 状态标签（T3 着色方案）。 */
function StatusLabel({ s }: { s: McpServerSnapshot }): ReactElement {
  switch (s.status) {
    case 'connected':
      return (
        <Text color="green">✓ 已连接</Text>
      )
    case 'connecting':
      return (
        <Text color="yellow">… 连接中</Text>
      )
    case 'failed':
      return (
        <Text color="red">✗ 失败{s.failedAgoSec !== undefined ? `（${s.failedAgoSec} 秒前）` : ''}</Text>
      )
    case 'disabled':
      return (
        <Text dimColor>⊘ 已禁用</Text>
      )
    case 'cached':
      return (
        <Text dimColor>○ 已缓存</Text>
      )
    default:
      return (
        <Text dimColor>○ 未连接</Text>
      )
  }
}

/** 错误词级换行（超长 URL 逐字符硬切），≤4 行截断。 */
function wrapError(msg: string, width: number): string[] {
  const maxChars = Math.max(8, Math.floor(width / 2))
  const words = msg.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    // 超长单词硬切
    const chunks: string[] = []
    for (let i = 0; i < w.length; i += maxChars) chunks.push(w.slice(i, i + maxChars))
    for (const c of chunks) {
      if (line === '') line = c
      else if (line.length + 1 + c.length <= maxChars) line += ' ' + c
      else {
        lines.push(line)
        line = c
      }
    }
  }
  if (line !== '') lines.push(line)
  return lines.slice(0, 4).concat(lines.length > 4 ? [`…（共 ${lines.length} 行，完整错误看日志）`] : [])
}

export function McpPanel({ snapshots, onReconnect, onDisconnect, onCancel, toolsOf }: McpPanelProps): ReactElement {
  const [view, setView] = useState<View>({ view: 'list' })
  const [cursorName, setCursorName] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined) // 操作中标记（行内反馈）

  // 详情视图的目标快照（hooks 必须先于条件 return——列表视图提前返回会漏挂）
  const detailSnap = view.view === 'list' ? undefined : snapshots.find((s) => s.name === view.server)
  // 配置被移除等边界：回列表（render 期 setState 是反模式，React 19 并发下易踩踏）
  useEffect(() => {
    if (view.view !== 'list' && detailSnap === undefined) setView({ view: 'list' })
  }, [view.view, detailSnap])

  if (view.view === 'list') {
    const rows: PanelRow<McpServerSnapshot>[] = snapshots.map((s) => ({
      type: 'item',
      value: s,
      disabled: s.status === 'disabled',
      label: (
        <>
          {s.name.padEnd(14)} <StatusLabel s={s} />
          {s.toolCount > 0 ? <Text dimColor>  {s.toolCount} 个工具</Text> : null}
        </>
      ),
    }))
    const expanded = snapshots.find((s) => s.name === cursorName && s.status === 'failed' && s.error !== undefined)
    return (
      <Box flexDirection="column">
        <PanelShell
          title="MCP 服务"
          subtitle={`${snapshots.length} 个`}
          rows={rows}
          onPick={(s) => {
            setCursorName(s.name)
            if (s.status !== 'disabled') setView({ view: 'detail', server: s.name })
          }}
          onCursor={(s) => setCursorName(s?.name)}
          onCancel={onCancel}
          filter={(s, q) => s.name.toLowerCase().includes(q.toLowerCase())}
          keyHints="↑↓ 选择 · 回车 详情 · ctrl+r 重连 · 输入即搜索 · Esc 退出"
          emptyHint="未配置 MCP server（~/.ecode/config.json 的 mcpServers 或项目 .mcp.json）"
        />
        {expanded !== undefined && expanded.error !== undefined && (
          <Box flexDirection="column" paddingLeft={4}>
            {wrapError(expanded.error, 60).map((l, i) => (
              <Text key={i} color="red">
                {l}
              </Text>
            ))}
            {busy === expanded.name ? (
              <Text color="yellow">（正在重连…）</Text>
            ) : (
              <Text dimColor>（可 /mcp reconnect {expanded.name} 或进详情操作）</Text>
            )}
          </Box>
        )}
        <CtrlRHandler
          onKey={() => {
            const target = cursorName ?? snapshots.find((s) => s.status !== 'disabled')?.name
            if (target === undefined) return
            setBusy(target)
            void onReconnect(target).finally(() => setBusy(undefined))
          }}
        />
      </Box>
    )
  }

  const snap = detailSnap
  if (snap === undefined) return <Box />

  if (view.view === 'tools') {
    const defs = toolsOf?.(snap.name) ?? []
    const rows: PanelRow<{ name: string; description?: string }>[] = defs.map((d) => ({
      type: 'item',
      value: d,
      label: `${d.name}  ${d.description ?? ''}`.slice(0, 72),
    }))
    return (
      <PanelShell
        title={`${snap.name} 的工具`}
        subtitle={`${defs.length} 个`}
        rows={rows}
        onPick={() => {}}
        onCancel={() => setView({ view: 'detail', server: snap.name })}
        keyHints="↑↓ 浏览 · 输入即搜索 · Esc 返回"
        emptyHint="（无工具——连接成功后 tools/list 会填充）"
      />
    )
  }

  // 详情视图：信息区 + 操作菜单
  const isKa = snap.lifecycle === 'keep-alive' || snap.lifecycle === 'lazy-keep-alive'
  const info: [string, ReactElement][] = [
    ['状态', <StatusLabel key="s" s={snap} />],
    ['类型', <Text key="t">{snap.type}{snap.source === 'project' ? ' · 项目级 .mcp.json' : ' · 用户级 config'}</Text>],
    ['lifecycle', <Text key="l">{snap.lifecycle}{isKa ? '（自动重连）' : ''}</Text>],
    ['工具', <Text key="w">{snap.toolCount} 个{snap.status === 'cached' ? '（缓存，调用时自动连接）' : ''}</Text>],
  ]
  if (snap.error !== undefined) info.push(['错误', <Text key="e" color="red">{snap.error}</Text>])
  const actions: { label: string; run: () => void }[] = [
    { label: '查看工具', run: () => setView({ view: 'tools', server: snap.name }) },
    {
      label: '重连',
      run: () => {
        setBusy(snap.name)
        void onReconnect(snap.name).finally(() => setBusy(undefined))
      },
    },
    {
      // 按状态分派（审阅 P1：cached/failed/not-connected 下「连接」必须是真连不是 close）
      label: snap.status === 'connected' ? '断开' : '连接',
      run: () => {
        if (snap.status === 'connected') void onDisconnect(snap.name)
        else {
          setBusy(snap.name)
          void onReconnect(snap.name).finally(() => setBusy(undefined))
        }
      },
    },
    { label: '返回列表', run: () => setView({ view: 'list' }) },
  ]
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {' '}
        {snap.name}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {info.map(([k, v]) => (
          <Text key={k}>
            {' '}
            {k.padEnd(9, '　')}
            {v}
          </Text>
        ))}
        {busy === snap.name ? (
          <Text color="yellow"> （操作中…状态实时刷新）</Text>
        ) : null}
      </Box>
      <Select
        items={actions.map((a, i) => ({ label: a.label, value: i }))}
        onSelect={(i) => actions[i]?.run()}
        onCancel={() => setView({ view: 'list' })}
      />
    </Box>
  )
}

/** ctrl+r 快捷键处理器（列表视图叠加；与 PanelShell 键位不相交）。 */
function CtrlRHandler({ onKey }: { onKey: () => void }): null {
  useInput((input, key) => {
    if (key.ctrl && input === 'r') onKey()
  })
  return null
}
