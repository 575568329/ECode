/**
 * Plugin 面板（M7 P-P5/P7）：`/plugin` 三页签——浏览市场 / 已安装 / 添加市场。
 *
 * 页签 ←→ 切换（PanelShell tabs 扩展）；浏览页 = 聚合市场插件 + 即时搜索 + 「已装」标记；
 * 详情 = 元数据 + 安装/打开主页；已安装详情 = 启用/禁用/卸载（含贡献资源生效状态——
 * P4.5 排障闭环）/返回；添加市场 = 文本输入（owner/repo | git URL | 本地路径）。
 * 安装行内进度（菜单项文字变「安装中…」，无进度条）；Esc 逐级（先清搜索词 → 退级 → 退出）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { TextInput } from './TextInput.js'
import { createCursor, type CursorState } from './cursor.js'
import { theme } from './theme.js'
import type { InstalledPlugin, PluginLoader } from '../services/plugin/loader.js'
import type { SkillRegistry } from '../services/skill.js'
import type { McpManager } from '../services/mcp/manager.js'
import type { ToolRegistry } from '../tools/interface.js'

interface BrowseItem {
  name: string
  marketplace: string
  description?: string
  version?: string
  installed: boolean
}

interface PluginPanelProps {
  loader: PluginLoader
  /** 卸载链/即时接入的 Registry 引用（P0-2/P1-9：disable/uninstall 走 teardown，install/enable 即时 loadOne） */
  skillRegistry: SkillRegistry
  tools: ToolRegistry | null
  mcp: McpManager | null
  /** 操作后刷新（browse/list 重查 + TuiApp 重渲染） */
  refresh: () => void
  /** systemMsgs 底部提示通道 */
  notify: (msg: string) => void
  onCancel: () => void
}

type View =
  | { view: 'main'; tab: number }
  | { view: 'detail'; item: BrowseItem }
  | { view: 'installed-detail'; plugin: InstalledPlugin }
  | { view: 'uninstall-confirm'; plugin: InstalledPlugin }
  | { view: 'add-market' }

const TABS = ['浏览市场', '已安装', '添加市场']

/** P1-7：贡献资源清单行（disabled——只读状态展示）。 */
function resourceStatusRows(p: InstalledPlugin): PanelRow<string>[] {
  const rows: PanelRow<string>[] = []
  const m = p.manifest
  const skillCount = m.skills?.length ?? undefined
  const mcpCount = Object.keys(m.mcpServers ?? {}).length
  const hookCount = (m.hooks?.length ?? 0) > 0 ? m.hooks?.length : undefined
  if (skillCount === undefined && mcpCount === 0 && hookCount === undefined) {
    rows.push({ type: 'item', value: '_ro_none', disabled: true, label: ' （清单未声明资源——组件靠目录约定发现）' })
    return rows
  }
  const line = (label: string): void => {
    rows.push({ type: 'item', value: `_ro_${rows.length}`, disabled: true, label: ` ${label}` })
  }
  if (skillCount !== undefined) line(`skills：${skillCount} 个源${p.enabled ? '' : '（已移除）'}`)
  if (mcpCount > 0) line(`mcpServers：${mcpCount} 个${p.enabled ? '' : '（已断开）'}`)
  if (hookCount !== undefined) line(`hooks：${hookCount} 条${p.enabled ? '' : '（已注销）'}`)
  return rows
}

export function PluginPanel({ loader, skillRegistry, tools, mcp, refresh, notify, onCancel }: PluginPanelProps): ReactElement {
  const [view, setView] = useState<View>({ view: 'main', tab: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // P1-6：数据 lazy 初始化一次（组件有 key={pluginPanelKey}，操作后 refresh remount 重查；
  // 原实现每次 render 都全量扫盘——装大市场后每个 setState 都是秒级同步 IO）
  const [browseData] = useState(() => loader.browse())
  const [installed] = useState(() => loader.list())
  const browseItems: BrowseItem[] = browseData.flatMap((m) =>
    m.plugins.map((p) => ({ ...p, marketplace: m.marketplace })),
  )

  const runAction = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      notify(label)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      refresh() // 失败也可能有部分状态变化（如 cache 半成品清理）
    } finally {
      setBusy(false)
    }
  }

  if (view.view === 'detail') {
    const { item } = view
    const rows: PanelRow<string>[] = [
      { type: 'item', value: 'install', label: busy ? '… 安装中…' : item.installed ? '已安装（重装将替换缓存）' : '安装', disabled: busy },
      { type: 'item', value: 'back', label: '返回' },
    ]
    return (
      <PanelShell
        title={`${item.name}（${item.marketplace} 市场）`}
        rows={rows}
        onPick={(v) => {
          if (v === 'install') {
            void runAction(`已安装 ${item.name}@${item.marketplace}（资源即时接入）`, async () => {
              await loader.install(item.name, item.marketplace)
              // P1-9：install 后即时接入（loadAll 循环体的单插件版）
              const installed = loader.list().find((p) => p.name === item.name && p.marketplace === item.marketplace)
              if (installed !== undefined) await loader.loadOne(installed, skillRegistry, mcp)
            }).then(() => setView({ view: 'main', tab: 0 }))
          } else setView({ view: 'main', tab: 0 })
        }}
        onCancel={() => setView({ view: 'main', tab: 0 })}
        keyHints="↑↓ 选择 · 回车 确认 · Esc 返回"
      >
      </PanelShell>
    )
  }

  if (view.view === 'installed-detail') {
    const { plugin } = view
    // P1-7：贡献资源清单 + 生效状态（排障闭环——"装了没效果"在此可见）
    const resourceRows = resourceStatusRows(plugin)
    const rows: PanelRow<string>[] = [
      { type: 'header', label: `${plugin.name}@${plugin.marketplace} · v${plugin.version} · ${plugin.enabled ? '已启用' : '已禁用'}` },
      ...resourceRows,
      { type: 'item', value: plugin.enabled ? 'disable' : 'enable', label: plugin.enabled ? '禁用（组件立即移除，保留缓存）' : '启用（组件即时接入）', disabled: busy },
      { type: 'item', value: 'uninstall', label: '卸载（删除缓存）', disabled: busy },
      { type: 'item', value: 'back', label: '返回' },
    ]
    return (
      <PanelShell
        title={`已安装详情`}
        rows={rows}
        onPick={(v) => {
          if (v === 'disable') {
            void runAction(`已禁用 ${plugin.name}（组件已移除）`, async () => {
              loader.setEnabled(plugin.name, plugin.marketplace, false)
              // P0-2：卸载链——hooks 注销 / MCP 杀进程+移除 / 工具反注册 / skill 移除
              await loader.teardown(plugin, skillRegistry, tools, mcp)
            }).then(() => setView({ view: 'main', tab: 1 }))
          } else if (v === 'enable') {
            void runAction(`已启用 ${plugin.name}`, async () => {
              loader.setEnabled(plugin.name, plugin.marketplace, true)
              await loader.loadOne(plugin, skillRegistry, mcp)
            })
          } else if (v === 'uninstall') {
            setView({ view: 'uninstall-confirm', plugin })
          } else setView({ view: 'main', tab: 1 })
        }}
        onCancel={() => setView({ view: 'main', tab: 1 })}
        keyHints="↑↓ 选择 · 回车 确认 · Esc 返回"
      />
    )
  }

  if (view.view === 'uninstall-confirm') {
    const { plugin } = view
    const rows: PanelRow<string>[] = [
      { type: 'header', label: `确认卸载 ${plugin.name}@${plugin.marketplace}？` },
      { type: 'item', value: 'yes', label: '卸载（删除缓存与配置）', disabled: busy },
      { type: 'item', value: 'no', label: '取消' },
    ]
    return (
      <PanelShell
        title="卸载确认"
        rows={rows}
        onPick={(v) => {
          if (v === 'yes') {
            void runAction(`已卸载 ${plugin.name}`, async () => {
              // P0-2：先走卸载链（hooks/MCP 子进程/工具/skill 立即清理）再删 cache
              if (plugin.enabled) await loader.teardown(plugin, skillRegistry, tools, mcp)
              await loader.uninstall(plugin.name, plugin.marketplace)
            }).then(() => setView({ view: 'main', tab: 1 }))
          } else setView({ view: 'installed-detail', plugin })
        }}
        onCancel={() => setView({ view: 'installed-detail', plugin })}
        keyHints="↑↓ 选择 · 回车 确认 · Esc 返回"
      />
    )
  }

  if (view.view === 'add-market') {
    return (
      <AddMarketView
        busy={busy}
        onSubmit={(source) =>
          void runAction(`已添加市场 ${source}`, async () => {
            await loader.addMarketplace(source)
          }).then(() => setView({ view: 'main', tab: 0 }))
        }
        onCancel={() => setView({ view: 'main', tab: 2 })}
        notify={notify}
      />
    )
  }

  // —— 三页签主视图 ——

  if (view.tab === 1) {
    const rows: PanelRow<InstalledPlugin>[] =
      installed.length === 0
        ? []
        : installed.map((p) => ({
            type: 'item' as const,
            value: p,
            label: ` ${p.name.padEnd(18)}${('@' + p.marketplace).padEnd(16)}v${p.version}  ${p.enabled ? '' : '⊘ 已禁用'}`,
          }))
    return (
      <PanelShell
        title="Plugin"
        subtitle={`已安装 · ${installed.length} 个`}
        tabs={TABS}
        activeTabIndex={1}
        onTabChange={(i) => setView({ view: 'main', tab: i })}
        rows={rows}
        onPick={(p) => setView({ view: 'installed-detail', plugin: p })}
        onCancel={onCancel}
        emptyHint="（尚未安装插件——去浏览市场页看看）"
        keyHints="↑↓ 选择 · 回车 详情 · 输入即搜索 · ←→ 切页 · Esc 退出"
      />
    )
  }

  if (view.tab === 2) {
    const rows: PanelRow<string>[] = [
      { type: 'item', value: 'add', label: ' 添加市场（owner/repo | git URL | 本地路径）' },
    ]
    return (
      <PanelShell
        title="Plugin"
        subtitle={`添加市场 · 已有 ${loader.listMarketplaces().length} 个`}
        tabs={TABS}
        activeTabIndex={2}
        onTabChange={(i) => setView({ view: 'main', tab: i })}
        rows={rows}
        onPick={(v) => {
          if (v === 'add') setView({ view: 'add-market' })
        }}
        onCancel={onCancel}
        keyHints="↑↓ 选择 · 回车 确认 · ←→ 切页 · Esc 退出"
      />
    )
  }

  // tab 0：浏览市场（默认）。零插件时给「添加市场」直达项（回车进添加页——
  // 不依赖用户发现 ←→ 页签；空态只留文案会让"添加市场"页变成隐形功能）
  const addDirectItem: BrowseItem = { name: '__add__', marketplace: '', installed: false }
  const rows: PanelRow<BrowseItem>[] =
    browseItems.length === 0
      ? [{ type: 'item', value: addDirectItem, label: ' ＋ 添加市场（owner/repo | git URL | 本地路径）——回车进入' }]
      : browseItems.map((p) => ({
          type: 'item',
          value: p,
          label: ` ${p.name.padEnd(18)}${p.marketplace.padEnd(10)}${(p.description ?? '').slice(0, 28)}${p.installed ? '  已装' : ''}`,
        }))
  return (
    <Box flexDirection="column">
      <PanelShell
        title="Plugin"
        subtitle={`浏览市场 · ${loader.listMarketplaces().length} 个市场 · ${browseItems.length} 个插件`}
        tabs={TABS}
        activeTabIndex={0}
        onTabChange={(i) => setView({ view: 'main', tab: i })}
        rows={rows}
        onPick={(p) => {
          if (p.name === '__add__') setView({ view: 'add-market' })
          else setView({ view: 'detail', item: p })
        }}
        onCancel={onCancel}
        emptyHint="（无市场——回车添加第一个市场）"
        keyHints="↑↓ 选择 · 回车 详情/确认 · 输入即搜索 · ←→ 切页 · Esc 退出"
      />
      {error !== null && (
        <Text color={theme.error}> ⚠ {error.slice(0, 120)}</Text>
      )}
    </Box>
  )
}

/** 添加市场页：文本输入 → 提交 clone/复制（失败行内错误）。 */
function AddMarketView({
  busy,
  onSubmit,
  onCancel,
  notify,
}: {
  busy: boolean
  onSubmit: (source: string) => void
  onCancel: () => void
  notify: (msg: string) => void
}): ReactElement {
  const [cur, setCur] = useState<CursorState>(() => createCursor(''))
  const [error] = useState<string | null>(null)
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold> 添加市场{busy ? '（处理中…）' : ''}</Text>
      <Box marginTop={1}>
        <Text dimColor> 来源（owner/repo | git URL | 本地路径）：</Text>
      </Box>
      <TextInput
        value={cur.text}
        caret={cur.caret}
        onInput={setCur}
        onSubmit={(v) => {
          const source = v.trim()
          if (source === '') return
          notify(`正在添加市场 ${source}…`)
          onSubmit(source)
        }}
        placeholder="owner/repo"
      />
      {error !== null && <Text color={theme.error}> ⚠ {error.slice(0, 120)}</Text>}
      <Box marginTop={1}>
        <Text dimColor> 回车 提交 · Esc 返回</Text>
      </Box>
    </Box>
  )
}
