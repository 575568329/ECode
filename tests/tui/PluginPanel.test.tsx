import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { PluginPanel } from '../../src/tui/PluginPanel.js'
import { PluginLoader } from '../../src/services/plugin/loader.js'
import { SkillRegistry } from '../../src/services/skill.js'

let tmpRoot: string
let loader: PluginLoader

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ecode-pluginpanel-'))
  loader = new PluginLoader({ baseDir: path.join(tmpRoot, 'plugins'), configPath: path.join(tmpRoot, 'config.json') })
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function makePanel() {
  return React.createElement(PluginPanel, {
    loader,
    skillRegistry: new SkillRegistry({ userDir: path.join(tmpRoot, 'skills') }),
    tools: null,
    mcp: null,
    refresh: () => {},
    notify: () => {},
    onCancel: () => {},
  })
}

describe('PluginPanel 空态直达（无市场时回车即添加）', () => {
  it('零插件 → 列表给「添加市场」直达项（不依赖 ←→ 发现页签）', () => {
    const { lastFrame } = render(makePanel())
    const f = lastFrame() ?? ''
    expect(f).toContain('添加市场')
    expect(f).toContain('回车进入')
  })

  it('直达项回车 → 进入添加市场输入视图', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\r')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('owner/repo')
    expect(f).toContain('回车 提交')
  })

  it('Esc 从添加视图返回浏览页', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\r')
    await flush()
    stdin.write('\u001b')
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('浏览市场')
  })

  it('onCancel 透传（浏览页 Esc）', async () => {
    const onCancel = vi.fn()
    const { stdin } = render(
      React.createElement(PluginPanel, {
        loader,
        skillRegistry: new SkillRegistry({ userDir: path.join(tmpRoot, 'skills') }),
        tools: null,
        mcp: null,
        refresh: () => {},
        notify: () => {},
        onCancel,
      }),
    )
    await flush()
    stdin.write('\u001b')
    await flush()
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('PluginPanel 页签切换（←→）', () => {
  it('浏览页 → → 切「已安装」页签', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001b[C')
    await flush()
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('已安装')
    expect(f).toContain('尚未安装插件')
  })

  it('已安装页 → → 再切「添加市场」页', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001b[C')
    await flush()
    stdin.write('\u001b[C')
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('添加市场')
  })

  it('浏览页 → ← 环绕到「添加市场」页', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001b[D')
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('添加市场')
  })

  it('SS3 变体（ESC O C，终端应用模式）同样切页', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001bOC')
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('已安装')
  })
})

describe('空列表页的页签切换（真机 bug 回归：已安装 0 项时 ← 被空列表守卫吞掉）', () => {
  it('已安装页（空列表）→ ← 切回浏览页', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001b[C') // → 已安装（0 安装，空列表）
    await flush()
    expect(lastFrame() ?? '').toContain('尚未安装插件')
    stdin.write('\u001b[D') // ← 应回浏览页（修复前被吞）
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('浏览市场 · 0 个市场')
  })

  it('空列表页 → → 可继续切到添加市场页（不被困）', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('\u001b[C') // → 已安装（空）
    await flush()
    stdin.write('\u001b[C') // → 添加市场页
    await flush()
    await flush()
    expect(lastFrame() ?? '').toContain('添加市场（owner/repo')
  })
})

describe('搜索态的页签切换与添加失败行内错误', () => {
  it('搜索态按 → 仍切页并清搜索词（搜索无光标编辑，左右不是死键）', async () => {
    const { stdin, lastFrame } = render(makePanel())
    await flush()
    stdin.write('x') // 进搜索态（无匹配）
    await flush()
    expect(lastFrame() ?? '').toContain('搜索：x')
    stdin.write('\u001b[C') // → 搜索态也切页
    await flush()
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('已安装')
    expect(f).not.toContain('搜索：x') // 搜索词已清（防残留过滤错乱）
  })

  it('添加市场失败 → 行内错误显示在本页（不再静默）', async () => {
    // 造一个必失败的市场目录（缺 marketplace.json）
    const badDir = path.join(tmpRoot, 'bad-market')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(badDir, { recursive: true })
    const panel = React.createElement(PluginPanel, {
      loader,
      skillRegistry: new SkillRegistry({ userDir: path.join(tmpRoot, 'skills') }),
      tools: null,
      mcp: null,
      refresh: () => {},
      notify: () => {},
      onCancel: () => {},
    })
    const { stdin, lastFrame } = render(panel)
    await flush()
    stdin.write('\r') // 直达项 → 添加市场视图
    await flush()
    stdin.write(badDir.split(path.sep).join('/'))
    await flush()
    stdin.write('\r') // 提交（目录缺 marketplace.json → addMarketplace throw）
    await new Promise((r) => setTimeout(r, 150))
    const f = lastFrame() ?? ''
    expect(f).toContain('⚠')
    expect(f).toContain('marketplace.json')
    expect(f).toContain('回车 提交') // 仍在添加页（可修改重试）
  })
})
