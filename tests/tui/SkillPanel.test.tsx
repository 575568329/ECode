/** SkillPanel（M6 T2）：分组/标记/Enter 回填文本/空态。 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { SkillPanel } from '../../src/tui/SkillPanel.js'
import { skillRegistry, type SkillInfo } from '../../src/services/skill.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  skillRegistry.clear()
})

function info(name: string, overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name,
    description: `技能 ${name}`,
    body: '',
    baseDir: `/tmp/${name}`,
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
    ...overrides,
  }
}

function P(skills: SkillInfo[], onPick: (s: string) => void = () => {}): ReturnType<typeof render> {
  return render(React.createElement(SkillPanel, { skills, onPick, onCancel: () => {} }))
}

describe('SkillPanel', () => {
  it('按来源分组渲染 + 仅手动标记', () => {
    const { lastFrame } = render(
      React.createElement(SkillPanel, {
        skills: [
          info('proj-skill', { source: 'project' }),
          info('user-skill'),
          info('manual', { disableModelInvocation: true }),
        ],
        onPick: () => {},
        onCancel: () => {},
      }),
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('项目级')
    expect(f).toContain('用户级')
    expect(f).toContain('proj-skill')
    expect(f).toContain('user-skill')
    expect(f).toContain('仅手动')
  })

  it('Enter → onPick 收到 `/name `（带尾随空格，回填不执行）', async () => {
    const onPick = vi.fn()
    const { stdin } = P([info('commit')], onPick)
    await flush()
    stdin.write('\r')
    await flush()
    expect(onPick).toHaveBeenCalledWith('/commit ')
  })

  it('搜索过滤（name/description）', async () => {
    const { stdin, lastFrame } = P([info('commit', { description: '按约定提交' }), info('review', { description: '审查' })])
    await flush()
    stdin.write('审查')
    await flush()
    expect(lastFrame() ?? '').toContain('review')
    expect(lastFrame() ?? '').not.toContain('commit')
  })

  it('空态提示创建入口', () => {
    const { lastFrame } = P([])
    expect(lastFrame() ?? '').toContain('/skill-create')
  })
})
