/**
 * /rewind 面板（M9-P2）：快照点列表（PanelShell 基线：输入即搜索/↑↓/翻页）→ 二级确认页。
 *
 * 二级确认页自建（不用 ConfirmPrompt——其纯字符串 preview 装不下文件清单与 ⚠ 着色标注，
 * 还原确认是独立语义）：列出将还原的文件；外部修改的文件 ⚠ 黄色标注；absent 项标注「将删除」；
 * y 还原 / Esc 取消。
 *
 * 运行中守卫（M9 风险表）：disabled（runningRef）时面板可看可选但确认禁用——
 * loop 与 rewind 同时写 messagesRef/文件会竞态。
 *
 * 2026-09-03 二轮审阅修复（安全席 P1-3/P2）：确认页清单改**还原范围并集**（选中点含之后
 * 全部快照的文件——原只列选中点自己的 files，文案却称「之后的全部改动撤销」=确认语义失真）；
 * absent 项显式标注「（将删除）」；外部修改文案中性化（快照是写前拍——「当前≠最近基线」
 * 在撤销自己最后一次改动的常见场景恒成立，狼来了归因弱化真警示）；revert 失败不再静默吞错
 *（原 onDone(null) 观感等同取消）——失败信息留面板明示。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { PanelShell } from './PanelShell.js'
import { theme } from './theme.js'
import type { CheckpointMeta, CheckpointFileRef } from '../services/checkpoint.js'

/** T 线 T2：面板数据面窄接口——CheckpointStore 真件与协议适配器（rewind/list+exec）同构实现，
 *  面板不再绑定存储实现（附着态走协议，Embedded 走真件或适配器）。 */
export interface RewindStore {
  list(sessionId: string): Promise<CheckpointMeta[]>
  detectExternalChanges(sessionId: string, seq: number, preloaded?: CheckpointMeta[]): Promise<string[]>
  revert(sessionId: string, seq: number): Promise<{ restored: string[]; externalChanged: string[]; failed?: string[] }>
}

/** 文件摘要最多列 3 个（多则 +N） */
const FILES_MAX = 3

export interface RewindResultLite {
  seq: number
  restoredCount: number
  /** 该点对应工具消息 id（投影截断锚；旧点可能缺省） */
  toolUseId?: string
}

interface RewindPanelProps {
  store: RewindStore | null
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
  const [error, setError] = useState('')

  useEffect(() => {
    void store
      ?.list(sessionId)
      .then((all) => setMetas([...all].reverse())) // 最新在最上
      .catch(() => setMetas([]))
  }, [store, sessionId])

  // 二级页外检：metas 预载复用（审阅修复：原每点全量重扫 list，O(点²) meta 读）
  useEffect(() => {
    if (selected === null || store === null) return
    setExternal(null)
    void store
      .detectExternalChanges(sessionId, selected.seq, metas)
      .then(setExternal)
      .catch(() => setExternal([]))
  }, [selected, store, sessionId, metas])

  useInput((input, key) => {
    if (selected === null) return
    if (reverting) return
    if (key.escape) {
      if (error !== '') {
        setError('') // 失败信息先清（Esc 两级：先清错再退回列表）
        return
      }
      setSelected(null) // 二级页 Esc 退回列表
      return
    }
    if (input === 'y' && !disabled && error === '') {
      const target = selected
      setReverting(true)
      void store
        ?.revert(sessionId, target.seq)
        .then((r) => {
          if (r.failed !== undefined && r.failed.length > 0) {
            // 部分失败：留面板明示（不再静默 onDone——观感等同取消且半程状态无反馈）
            setReverting(false)
            setError(`${r.failed.length} 个文件还原失败（${r.failed.map((p) => p.replace(/\\/g, '/').split('/').pop() ?? p).join('、')}）——其余 ${r.restored.length} 个已完成，Esc 返回`)
            return
          }
          onDone({ seq: target.seq, restoredCount: r.restored.length, toolUseId: target.messageId })
        })
        .catch((e: unknown) => {
          setReverting(false)
          setError(`还原失败：${e instanceof Error ? e.message : String(e)}（Esc 返回）`)
        })
    }
  })

  if (selected !== null) {
    const externalSet = new Set(external ?? [])
    // 确认页清单 = 还原范围并集（选中点含之后全部快照）——与 revert 实际执行同口径
    const range = metas.filter((m) => m.seq >= selected.seq)
    const filesMap = new Map<string, CheckpointFileRef>()
    for (const m of range) for (const f of m.files) filesMap.set(f.path, f)
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
        <Text color={theme.warn} bold> ⇺ 回退至快照点 {selected.seq}（{summaryOf(selected)}）</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor> 将还原以下文件（该点之后的全部改动撤销）：</Text>
          {[...filesMap.entries()].map(([path, f]) => {
            const name = path.replace(/\\/g, '/')
            if (f.absent === true) {
              return (
                <Text key={path} color={theme.warn}> ⚠ {name}（将删除——快照时刻此文件不存在）</Text>
              )
            }
            const changed = externalSet.has(path)
            return changed ? (
              <Text key={path} color={theme.warn}> ⚠ {name}（当前内容与快照基线不同，还原将覆盖现有内容）</Text>
            ) : (
              <Text key={path}> {name}</Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          {reverting ? (
            <Text dimColor> 还原中…</Text>
          ) : error !== '' ? (
            <Text color={theme.error}> ✗ {error}</Text>
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
