/**
 * /rewind 面板（M9-P2）：快照点列表（PanelShell 基线：输入即搜索/↑↓/翻页）→ 二级确认页。
 *
 * 二级确认页自建（不用 ConfirmPrompt——其纯字符串 preview 装不下文件清单与 ⚠ 着色标注，
 * 还原确认是独立语义）：列出将还原的文件；外部修改的文件 ⚠ 黄色标注「还原将覆盖」；
 * y 还原 / Esc 取消。
 *
 * 运行中守卫（M9 风险表）：disabled（runningRef）时面板可看可选但确认禁用——
 * loop 与 rewind 同时写 messagesRef/文件会竞态。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { PanelShell } from './PanelShell.js'
import { theme } from './theme.js'
import type { CheckpointMeta, CheckpointStore } from '../services/checkpoint.js'

/** 文件摘要最多列 3 个（多则 +N） */
const FILES_MAX = 3

export interface RewindResultLite {
  seq: number
  restoredCount: number
  /** 该点对应工具消息 id（投影截断锚；旧点可能缺省） */
  toolUseId?: string
}

interface RewindPanelProps {
  store: CheckpointStore | null
  sessionId: string
  /** 本轮运行中（runningRef）——确认禁用（可看可选） */
  disabled: boolean
  /** 还原完成（seq + 实际还原文件数）；null = 用户取消关闭 */
  onDone: (r: RewindResultLite | null) => void
}

/** meta 行摘要：HH:MM  工具  文件列表（≤3 + N） */
function summaryOf(m: CheckpointMeta): string {
  const hhmm = m.time.slice(11, 16)
  const base = m.files.map((f) => f.path.replace(/\\/g, '/').split('/').pop() ?? f.path)
  const shown = base.slice(0, FILES_MAX).join('、')
  const more = base.length > FILES_MAX ? ` +${base.length - FILES_MAX}` : ''
  const label = `${m.tool === 'rewind-auto' ? '(还原前自动)' : m.tool}`
  return `${hhmm}  ${label}  ${shown}${more}`
}

export function RewindPanel({ store, sessionId, disabled, onDone }: RewindPanelProps): ReactElement {
  const [metas, setMetas] = useState<CheckpointMeta[]>([])
  const [selected, setSelected] = useState<CheckpointMeta | null>(null)
  const [external, setExternal] = useState<string[] | null>(null) // null = 检测中/无
  const [reverting, setReverting] = useState(false)

  useEffect(() => {
    void store
      ?.list(sessionId)
      .then((all) => setMetas([...all].reverse())) // 最新在最上
      .catch(() => setMetas([]))
  }, [store, sessionId])

  useEffect(() => {
    if (selected === null || store === null) return
    setExternal(null)
    void store
      .detectExternalChanges(sessionId, selected.seq)
      .then(setExternal)
      .catch(() => setExternal([]))
  }, [selected, store, sessionId])

  useInput((input, key) => {
    if (selected === null) return
    if (reverting) return
    if (key.escape) {
      setSelected(null) // 二级页 Esc 退回列表
      return
    }
    if (input === 'y' && !disabled) {
      const target = selected
      setReverting(true)
      void store
        ?.revert(sessionId, target.seq)
        .then((r) => onDone({ seq: target.seq, restoredCount: r.restored.length, toolUseId: target.messageId }))
        .catch((e: unknown) => {
          setReverting(false)
          onDone(null)
          void e
        })
    }
  })

  if (selected !== null) {
    const externalSet = new Set(external ?? [])
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
        <Text color={theme.warn} bold> ⇺ 回退至快照点 {selected.seq}（{summaryOf(selected)}）</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor> 将还原以下文件（该点之后的全部改动撤销）：</Text>
          {selected.files.map((f) => {
            const changed = externalSet.has(f.path)
            const name = f.path.replace(/\\/g, '/')
            return changed ? (
              <Text key={f.path} color={theme.warn}> ⚠ {name}（快照后有外部修改，还原将覆盖）</Text>
            ) : (
              <Text key={f.path}> {name}</Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          {reverting ? (
            <Text dimColor> 还原中…</Text>
          ) : disabled ? (
            <Text dimColor> 本轮运行结束后才能回退（运行中还原会与工具写入竞态）· Esc 返回</Text>
          ) : (
            <Text dimColor> y 还原 · Esc 取消</Text>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <PanelShell<number>
      title="回退到哪个改动之前"
      subtitle={metas.length > 0 ? `${metas.length} 个快照点（最新在上）` : undefined}
      rows={metas.map((m) => ({ type: 'item' as const, label: summaryOf(m), value: m.seq }))}
      onPick={(seq) => {
        const m = metas.find((x) => x.seq === seq)
        if (m !== undefined) setSelected(m)
      }}
      onCancel={() => onDone(null)}
      emptyHint="（本会话还没有任何改动）"
      keyHints="↑↓ 选择 · 回车 查看还原清单 · 输入即搜索 · Esc 返回"
    />
  )
}
