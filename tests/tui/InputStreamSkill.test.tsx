/**
 * InputStream 的 M6 S-P5 行为：skill 分流 / 补全合并 / insert 通道 / 空格停匹配。
 * skillRegistry 单例注入测试数据（clear 隔离；私有 map 直塞避免触盘）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { SlashSuggest, InputStream } from '../../src/tui/InputStream.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import { skillRegistry, type SkillInfo } from '../../src/services/skill.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  commandRegistry.clear()
  registerBuiltinCommands()
  skillRegistry.clear()
})

function reg(name: string, overrides: Partial<SkillInfo> = {}): void {
  ;(skillRegistry as unknown as { skills: Map<string, SkillInfo> }).skills.set(name, {
    name,
    description: `技能 ${name}`,
    body: `# ${name}`,
    baseDir: `/tmp/${name}`,
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
    ...overrides,
  } as SkillInfo)
}

describe('SlashSuggest：skill 合并（S-P5）', () => {
  it('skill 出现在补全列表 + (skill) 标记，命令在前', () => {
    reg('commit')
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('/commit')
    expect(f).toContain('(skill)')
    expect(f.indexOf('/help')).toBeLessThan(f.indexOf('/commit')) // 命令在前（内置优先分流）
  })

  it('user-invocable:false 不出现在补全', () => {
    reg('hidden', { userInvocable: false })
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/hid' }))
    expect(lastFrame() ?? '').toBe('')
  })

  it('与内置命令撞名 → (被命令遮蔽) 标记', () => {
    reg('help')
    ;(skillRegistry.shadowedByCommand as unknown as Set<string>).add('help')
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/hel' }))
    expect(lastFrame() ?? '').toContain('(被命令遮蔽)')
  })

  it('含空格（命令名+参数）→ 停止匹配', () => {
    reg('commit')
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/commit 修复' }))
    expect(lastFrame() ?? '').toBe('')
  })
})

describe('InputStream：skill 分流（S-P5）', () => {
  it('/skill-name args → onSkillInvoke(name, args)', async () => {
    reg('commit')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    stdin.write('/commit 修复登录')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('commit', '修复登录')
  })

  it('/skill-name 无参 → onSkillInvoke(name, undefined)', async () => {
    reg('commit')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    stdin.write('/commit')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('commit', undefined)
  })

  it('/命令名命中命令 → 优先走命令（即使有同名 skill）', async () => {
    reg('help')
    const onCommand = vi.fn()
    const onSkillInvoke = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, { onSubmit: () => {}, onCommand, onSkillInvoke }),
    )
    stdin.write('/help extra')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onCommand).toHaveBeenCalled()
    expect(onSkillInvoke).not.toHaveBeenCalled()
  })

  it('user-invocable:false 直接敲 → 拦截提示（不触发 onSkillInvoke）', async () => {
    reg('llmonly', { userInvocable: false })
    const onSkillInvoke = vi.fn()
    const onCommand = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, { onSubmit: () => {}, onCommand, onSkillInvoke }),
    )
    stdin.write('/llmonly')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).not.toHaveBeenCalled()
    expect(onCommand).toHaveBeenCalled()
    const output = (onCommand.mock.calls[0]?.[1] as { output?: string }).output ?? ''
    expect(output).toContain('仅限模型调用')
  })

  it('命令带参：run(args) 收到参数文本', async () => {
    commandRegistry.register({
      name: 'echo',
      description: '',
      run: (args) => ({ output: `got:${args ?? ''}` }),
    })
    const onCommand = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onCommand }))
    stdin.write('/echo a b')
    await flush()
    stdin.write('\r')
    await flush()
    const result = onCommand.mock.calls[0]?.[1] as { output?: string }
    expect(result?.output).toBe('got:a b')
  })

  it('Tab 补全带尾随空格（提示可接参数；空格后停匹配）', async () => {
    reg('commit')
    const { stdin, lastFrame } = render(React.createElement(InputStream, { onSubmit: () => {} }))
    stdin.write('/commi') // 避开命令 compact（命令在前会先选中）
    await flush()
    stdin.write('\t')
    await flush()
    // 尾随空格后建议列表消失（停止命令名匹配），输入框含补全名
    const f = lastFrame() ?? ''
    expect(f).toContain('commit')
    expect(f).not.toContain('(skill)')
  })
})

describe('InputStream：insert 回填通道（S-P6）', () => {
  it('seq 变化 → text 写入输入框；同 seq 幂等', async () => {
    const { stdin, rerender, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, insert: { text: '/commit ', seq: 1 } }),
    )
    await flush()
    expect(lastFrame() ?? '').toContain('commit')
    rerender(React.createElement(InputStream, { onSubmit: () => {}, insert: { text: '/review ', seq: 2 } }))
    await flush()
    expect(lastFrame() ?? '').toContain('review')
    // 同 seq 幂等（不重写用户已编辑的内容）
    stdin.write('x') // 用户续写
    await flush()
    rerender(React.createElement(InputStream, { onSubmit: () => {}, insert: { text: '/other ', seq: 2 } }))
    await flush()
    expect(lastFrame() ?? '').toContain('x')
    expect(lastFrame() ?? '').not.toContain('other')
  })
})
