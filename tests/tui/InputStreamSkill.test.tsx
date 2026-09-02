/**
 * InputStream 的 M6 S-P5 行为：skill 分流 / 补全合并 / insert 通道 / 空格停匹配。
 * skillRegistry 单例注入测试数据（clear 隔离；私有 map 直塞避免触盘）。
 */
import {describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { SlashSuggest, InputStream, matchSlashEntries } from '../../src/tui/InputStream.js'
import { commandRegistry, registerBuiltinCommands } from '../../src/commands/registry.js'
import { skillRegistry, type SkillInfo } from '../../src/services/skill.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

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
    reg('aa-skill') // 前缀 aa 只匹配 skill——窗口化（6 行）后用精确前缀避免窗口外断言
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/aa-s' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('/aa-skill')
    expect(f).toContain('(skill)')
  })

  it('窗口化：超 6 条显示计数提示，命令顺序不变（窗口内）', () => {
    const { lastFrame } = render(React.createElement(SlashSuggest, { text: '/' }))
    const f = lastFrame() ?? ''
    expect(f).toContain('↓ 还有') // 命令 17 条 > 窗口 6
    expect(f).toContain('共 ')
    expect(f.indexOf('/help')).toBeLessThan(f.indexOf('/clear')) // 窗口内保持注册序
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
    stdin.write('\r') // 回填后再回车执行
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('commit', '修复登录')
  })

  it('Tab 不补全（已专职沙箱档位，M9-D13）——补全只走回车', async () => {
    reg('commit')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    stdin.write('/comm')
    await flush()
    stdin.write('\t')
    await flush()
    stdin.write('\r') // Tab 若曾补全（文本带尾随空格）此回车会直接执行；现在应只回填不执行
    await flush()
    expect(onSkillInvoke).not.toHaveBeenCalled()
    stdin.write('\r') // 再回车（此时文本已带空格）→ 执行
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('commit', undefined)
  })

  it('/skill-name 无参 → onSkillInvoke(name, undefined)', async () => {
    reg('commit')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    stdin.write('/commit')
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r') // 回填后再回车执行
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
    stdin.write('\r') // 回填后再回车执行
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
    stdin.write('\r') // 回填后再回车执行
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
    stdin.write('\r') // 回填后再回车执行
    await flush()
    const result = onCommand.mock.calls[0]?.[1] as { output?: string }
    expect(result?.output).toBe('got:a b')
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

describe('统一两段式（用户拍板：回车=回填，再回车=执行）', () => {
  it('命令：第一个回车只回填（尾随空格+补全消失），不执行；第二个回车执行', async () => {
    commandRegistry.register({ name: 'zz-run', description: '', run: () => ({ output: 'RAN' }) })
    const onCommand = vi.fn()
    const { stdin, lastFrame } = render(React.createElement(InputStream, { onSubmit: () => {}, onCommand }))
    await flush()
    stdin.write('/zz-ru')
    await flush()
    stdin.write('\r') // 第一个回车 = 回填
    await flush()
    expect(onCommand).not.toHaveBeenCalled() // 不执行
    const f = lastFrame() ?? ''
    expect(f).toContain('zz-run')
    expect(f).not.toContain('(skill)') // 补全列表消失（空格停匹配）
    stdin.write('\r') // 第二个回车 = 执行
    await flush()
    expect(onCommand).toHaveBeenCalledTimes(1)
  })

  it('skill：第一个回车回填 `/name `，第二个回车触发 onSkillInvoke', async () => {
    reg('commit')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    await flush()
    stdin.write('/commi')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).not.toHaveBeenCalled()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('commit', undefined)
  })

  it('↑↓ 选中后回车回填选中项（非第一个）', async () => {
    reg('zz-sa')
    reg('zz-sb')
    const onSkillInvoke = vi.fn()
    const { stdin } = render(React.createElement(InputStream, { onSubmit: () => {}, onSkillInvoke }))
    await flush()
    stdin.write('/zz-s') // 只有两个 skill 匹配，无命令干扰
    await flush()
    stdin.write('\u001b[B') // ↓ 选中第二项 zz-sb
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSkillInvoke).toHaveBeenCalledWith('zz-sb', undefined)
  })
})

describe('matchSlashEntries 跨组排序（命令在前 skill 在后——纯函数直测，审阅 P1-8）', () => {
  it('命令组全部在 skill 组之前；组内保持注册/字母序', () => {
    reg('zz-skill')
    reg('aa-skill')
    const entries = matchSlashEntries('')
    const firstSkill = entries.findIndex((e) => e.kind === 'skill')
    expect(firstSkill).toBeGreaterThan(-1)
    for (let i = 0; i < firstSkill; i++) expect(entries[i]?.kind).toBe('cmd')
    for (let i = firstSkill; i < entries.length; i++) expect(entries[i]?.kind).toBe('skill')
    const skillNames = entries.slice(firstSkill).map((e) => e.name)
    expect(skillNames).toEqual(['zz-skill', 'aa-skill']) // 组内注册序（zz 先注册）
  })
})


describe('SlashSuggest 窗口滚动计数边界（审阅 P1-1 修复的锁定）', () => {
  it('↓ 持续到底：下方计数归零（不再骗"还有 N 条"），上方计数出现', async () => {
    const { stdin, lastFrame } = render(React.createElement(InputStream, { onSubmit: () => {} }))
    await flush()
    stdin.write('/')
    await flush()
    // 自适应按到底（条目数受本文件其它用例注册的 skill 残留影响，不写死次数）
    let frame = lastFrame() ?? ''
    for (let i = 0; i < 30 && frame.includes('↓ 还有'); i++) {
      stdin.write('\u001b[B')
      await flush()
      frame = lastFrame() ?? ''
    }
    expect(frame).not.toContain('↓ 还有') // 光标到末项，下方 0 条（修复前滚到底仍显示"还有 N 条"）
    expect(frame).toContain('↑ 还有') // 头部被滚出，上方计数出现
    expect(frame).toContain('共 ') // 总数恒可见
  })
})

describe('批2b 配套：两段式回填态与 busy 拦截', () => {
  it('回填态（/name+空格）Esc 清空输入框（两段式残留吞消息的出口）', async () => {
    const { stdin, lastFrame } = render(React.createElement(InputStream, { onSubmit: () => {} }))
    await flush()
    stdin.write('/he')
    await flush()
    stdin.write('\r') // 回填 `/help `（两段式；尾随空格停匹配→建议列表消失）
    await flush()
    const f1 = lastFrame() ?? ''
    expect(f1).toContain('/help') // 回填可见
    expect(f1).not.toContain('回车 填入') // 建议列表已隐（带空格停匹配）
    stdin.write('\x1b') // Esc 取消
    await flush()
    const f2 = lastFrame() ?? ''
    expect(f2).not.toContain('/help') // 清空
  })

  it('busy 拦截斜杠命令：提示但保留命令文本（不吞）', async () => {
    const onSlashBusy = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, busy: true, onSlashBusy }),
    )
    await flush()
    stdin.write('/不存在的命令xyz')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSlashBusy).toHaveBeenCalledTimes(1)
    const f = lastFrame() ?? ''
    expect(f).toContain('/不存在的命令xyz') // 文本仍在输入框（批2b：只提示不吞）
  })

  it('R4/D14：/output 已退役——busy 下不再白名单放行（走 onSlashBusy 拦截）', async () => {
    const onSlashBusy = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, { onSubmit: () => {}, busy: true, onSlashBusy, onCommand: vi.fn() }),
    )
    await flush()
    stdin.write('/output')
    await flush()
    stdin.write('\r')
    await flush(60)
    expect(onSlashBusy).toHaveBeenCalled() // 不在白名单 → busy 拦截（不再有 open-output-panel 动作）
  })

  it('F-46 busy 放行只读白名单：/warnings 执行、白名单外仍拦（活动流 D14：/output 已退役出白名单）', async () => {
    const onCommand = vi.fn()
    const onSlashBusy = vi.fn()
    const { stdin } = render(
      React.createElement(InputStream, { onSubmit: () => {}, busy: true, onSlashBusy, onCommand }),
    )
    await flush()
    stdin.write('/warnings') // 白名单内：busy 放行
    await flush()
    stdin.write('\r') // 补全面板：填入
    await flush()
    stdin.write('\r') // 执行
    await flush(60)
    expect(onCommand).toHaveBeenCalledTimes(1)
    stdin.write('/clear') // 白名单外：仍拦（与 runLoop 竞态）
    await flush()
    stdin.write('\r') // 补全面板：填入
    await flush()
    stdin.write('\r') // 执行
    await flush(60)
    expect(onSlashBusy).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledTimes(1) // 仍 1
  })

  it('空闲态提交命令后清空（对照：busy 保留是特例）', async () => {
    const onCommand = vi.fn()
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, onCommand }),
    )
    await flush()
    stdin.write('/不存在的命令xyz')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onCommand).toHaveBeenCalled()
    expect(lastFrame() ?? '').not.toContain('/不存在的命令xyz')
  })
})
