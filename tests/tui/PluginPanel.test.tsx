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
