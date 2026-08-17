/**
 * /config 面板（M10-P2）：三页签（常规/Providers 只读/高级）+ 搜索 + jsonc 非破坏保存。
 *
 * 语义（v1.9 澄清）：面板改 current/模型 = 落盘改 default 键（持久启动默认）——与 /model 的
 * 会话临时切换并存；保存走 jsonc modify 只动目标键（writeWizardConfig 先例），注释/未知键不动。
 * 逃生口：打开配置文件夹（explorer/open 现状——$EDITOR+suspend 后置观察区，不重蹈 M4 覆辙）。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Text } from 'ink'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { openConfigDir } from '../services/configFs.js'

/** 面板可编辑项（常规页）——键路径与编辑形态 */
export interface ConfigItem {
  key: string
  label: string
  /** 当前值展示 */
  value: string
  /** 候选（枚举档位；数值项也用档位——不手敲） */
  options?: string[]
  kind: 'enum' | 'toggle' | 'readonly'
}

export interface ConfigPanelProps {
  current: { provider: string; model: string }
  providers: Array<{ name: string; type: string; models: string[]; baseURL?: string; hasKey: boolean }>
  /** 通用可编辑项（maxIterations/thinking/autoCommit/webSearch.provider…） */
  general: ConfigItem[]
  /** 保存（key 路径 + 值；调用方 jsonc modify 落盘） */
  onSave: (path: string, value: unknown) => Promise<void>
  onClose: () => void
}

type Page = '常规' | 'Providers' | '高级'

export function ConfigPanel({ current, providers, general, onSave, onClose }: ConfigPanelProps): ReactElement {
  const [page, setPage] = useState<Page>('常规')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!busy) return
    // 保存后短暂提示再退出（简化：保存完成即关面板）
  }, [busy])

  const pages: Page[] = ['常规', 'Providers', '高级']
  const tabIndex = pages.indexOf(page)

  const pick = async (path: string, value: unknown): Promise<void> => {
    setBusy(true)
    try {
      await onSave(path, value)
    } finally {
      setBusy(false)
      onClose()
    }
  }

  let rows: PanelRow<string>[] = []
  if (page === '常规') {
    // provider 与模型（落盘 default 键——持久默认；会话内切换仍走 /model）
    const cur = providers.find((p) => p.name === current.provider)
    rows = [
      { type: 'item', label: `Provider（当前 ${current.provider}）—— 落盘为启动默认`, value: `provider:${current.provider}` },
      ...(cur?.models ?? []).map((m): PanelRow<string> => ({
        type: 'item',
        label: `  模型 ${m}${m === current.model ? '  ◀ 当前' : ''}`,
        value: `model:${m}`,
      })),
      { type: 'header', label: '通用项（回车切换/选择，落盘生效）' },
      ...general.map((it): PanelRow<string> => ({
        type: 'item',
        label: `${it.label} = ${it.value}`,
        value: `item:${it.key}`,
        disabled: it.kind === 'readonly',
      })),
    ]
  } else if (page === 'Providers') {
    rows = [
      { type: 'header', label: 'Providers（只读——敏感项面板不代编，打开原始文件改）' },
      ...providers.map((p): PanelRow<string> => ({
        type: 'item',
        label: `${p.name} · ${p.type} · ${p.models.length} 模型 · key${p.hasKey ? '✓' : '✗'}${p.baseURL !== undefined ? ` · ${p.baseURL}` : ''}`,
        value: `prov:${p.name}`,
        disabled: true,
      })),
    ]
  } else {
    rows = [
      { type: 'header', label: '高级键（只读展示；改值请打开原始 config）' },
      { type: 'item', label: 'mcpServers / hooks / plugins 启用态等', value: 'adv:', disabled: true },
      { type: 'header', label: '逃生口' },
      { type: 'item', label: '打开配置文件夹（~/.ecode/）', value: 'open' },
    ]
  }

  return (
    <PanelShell<string>
      title={`配置（页签 ${tabIndex + 1}/${pages.length}：${page}）`}
      subtitle="回车应用并落盘（jsonc 非破坏，注释保留）；/model 仍是会话内临时切换"
      rows={rows}
      onPick={(v) => {
        if (v === 'open') {
          void openConfigDir()
          return
        }
        if (v.startsWith('provider:')) {
          void pick('default.provider', v.slice('provider:'.length))
          return
        }
        if (v.startsWith('model:')) {
          void pick('default.model', v.slice('model:'.length))
          return
        }
        if (v.startsWith('item:')) {
          const it = general.find((g) => g.key === v.slice('item:'.length))
          if (it !== undefined && it.options !== undefined && it.options.length > 0) {
            // 循环切换到下一档（toggle 单键即真伪；档位回车逐档）
            const idx = it.options.indexOf(it.value)
            const next = it.options[(idx + 1) % it.options.length] ?? it.options[0] ?? ''
            void pick(it.key, normalizeValue(next))
          }
        }
      }}
      onCancel={onClose}
      tabs={pages}
      activeTabIndex={tabIndex}
      onTabChange={(i) => setPage(pages[i] ?? '常规')}
      keyHints="←→ 页签 · 回车 应用/切换 · 输入即搜索 · Esc 关闭"
    />
  )
}

/** "true"/"false"/数字串 → 原生类型（jsonc modify 需要） */
function normalizeValue(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

export function ConfigPanelFooterNote(): ReactElement {
  return <Text dimColor> </Text>
}
