/**
 * Skill 面板（M6 T2/S-P6）：`/skill` 二级菜单——按来源分组 + 即时搜索 + Enter 回填选用。
 *
 * Enter = 把 `/skillname `（带尾随空格）回填主输入框（D32：不直接执行——
 * 保留 $ARGUMENTS 传参机会 + 所见即所发）；回填后用户直接回车 = 无参执行。
 * 手动面只列 user-invocable skill；disable-model-invocation 的标「仅手动」。
 */

import type { ReactElement } from 'react'
import { Text } from 'ink'
import { PanelShell, type PanelRow } from './PanelShell.js'
import { skillDesc } from '../services/skill/listing.js'
import { skillRegistry, type SkillInfo } from '../services/skill.js'

interface SkillPanelProps {
  /** 手动可用 skill（listForCompletion 结果，TuiApp 传入） */
  skills: SkillInfo[]
  /** 选用：回填文本（`/name `）交 TuiApp 写入输入框并关面板 */
  onPick: (fill: string) => void
  onCancel: () => void
}

export function SkillPanel({ skills, onPick, onCancel }: SkillPanelProps): ReactElement {
  // 分组：项目级 → 用户级 → 内置 → 其他（发现优先级序；builtin 为随包手册，用户可同名覆盖）
  const groups: { label: string; source: SkillInfo['source'][] }[] = [
    { label: '项目级（.ecode/skills/）', source: ['project'] },
    { label: '用户级（~/.ecode/skills/）', source: ['user'] },
    { label: '内置', source: ['builtin'] },
    { label: '其他', source: ['plugin'] },
  ]
  const rows: PanelRow<SkillInfo>[] = []
  for (const g of groups) {
    const list = skills.filter((s) => g.source.includes(s.source))
    if (list.length === 0) continue
    rows.push({ type: 'header', label: g.label })
    for (const s of list) {
      rows.push({
        type: 'item',
        // 被内置命令遮蔽的 skill 回填后会命中同名命令（面板自造陷阱）——禁选，只展示
        disabled: skillRegistry.shadowedByCommand.has(s.name),
        value: s,
        label: (
          <>
            {s.name.padEnd(16)} {skillDesc(s).slice(0, 40)}
            {s.disableModelInvocation ? <Text color="yellow">  仅手动</Text> : null}
            {skillRegistry.shadowedByCommand.has(s.name) ? <Text color="yellow">  被命令遮蔽</Text> : null}
          </>
        ),
      })
    }
  }
  // M7 P4.5：被同名遮蔽的 skill 灰显列出（数据不消失，状态标清楚；禁选——不在注册表，回填无效）
  if (skillRegistry.shadowedEntries.length > 0) {
    rows.push({ type: 'header', label: '同名冲突（被遮蔽，不生效）' })
    for (const sh of skillRegistry.shadowedEntries) {
      rows.push({
        type: 'item',
        disabled: true,
        value: { name: sh.name, description: '', body: '', baseDir: sh.loserPath, source: 'plugin', userInvocable: false, disableModelInvocation: true },
        label: (
          <Text dimColor>
            {sh.name.padEnd(16)} 被 {sh.winnerSource} 级遮蔽（{sh.loserPath}）
          </Text>
        ),
      })
    }
  }
  return (
    <PanelShell
      title="Skill"
      subtitle={`${skills.length} 个技能`}
      rows={rows}
      onPick={(s) => onPick(`/${s.name} `)}
      onCancel={onCancel}
      filter={(s, q) => s.name.toLowerCase().includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase())}
      emptyHint="暂无技能。创建：/skill-create；目录：~/.ecode/skills/<name>/SKILL.md"
    />
  )
}
