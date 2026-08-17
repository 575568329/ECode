/** ConfigPanel + saveConfigKey 测（M10-P2）：三页签/保存非破坏/逃生口。 */
import { describe, expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigPanel } from '../../src/tui/ConfigPanel.js'
import { saveConfigKey } from '../../src/services/configFs.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

function panel(over?: Partial<Parameters<typeof ConfigPanel>[0]>) {
  const onSave = vi.fn(async () => {})
  const onClose = vi.fn()
  const r = render(
    React.createElement(ConfigPanel, {
      current: { provider: 'astron', model: 'glm-4.6' },
      providers: [{ name: 'astron', type: 'anthropic', models: ['glm-4.6', 'glm-4.6v'], baseURL: 'https://x', hasKey: true }],
      general: [
        { key: 'maxIterations', label: 'maxIterations', value: '50', options: ['20', '50', '100'], kind: 'enum' },
        { key: 'autoCommit', label: 'autoCommit', value: 'false', options: ['false', 'true'], kind: 'toggle' },
      ],
      onSave,
      onClose,
      ...over,
    }),
  )
  return { ...r, onSave, onClose }
}

describe('ConfigPanel', () => {
  it('常规页：provider/模型/通用项 + 当前标记 + 页签计数', () => {
    const { lastFrame } = panel()
    const f = lastFrame() ?? ''
    expect(f).toContain('配置（页签 1/3：常规）')
    expect(f).toContain('astron')
    expect(f).toContain('glm-4.6  ◀ 当前')
    expect(f).toContain('maxIterations = 50')
    expect(f).toContain('落盘为启动默认')
  })

  it('←→ 切页签：Providers 只读（key✓/baseURL）/高级页逃生口', async () => {
    const { stdin, lastFrame } = panel()
    stdin.write('\u001b[D') // ← 到高级（环绕）或按两次 → 到 Providers
    await flush()
    const f1 = lastFrame() ?? ''
    expect(f1).toContain('高级')
    expect(f1).toContain('打开配置文件夹')
    stdin.write('\u001b[C') // → 回常规
    await flush()
    stdin.write('\u001b[C') // → Providers
    await flush()
    const f2 = lastFrame() ?? ''
    expect(f2).toContain('Providers')
    expect(f2).toContain('anthropic')
    expect(f2).toContain('key✓')
  })

  it('选模型 → onSave(default.model, 值)；Esc → onClose', async () => {
    const { stdin, onSave, onClose } = panel()
    await flush()
    stdin.write('\u001b[B') // ↓ 到第一个模型
    await flush()
    stdin.write('\r')
    await flush()
    expect(onSave).toHaveBeenCalledWith('default.model', 'glm-4.6')
    stdin.write('\u001b')
    await flush()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('saveConfigKey（jsonc 非破坏，真文件）', () => {
  it('改单键：注释/未知键/格式保留；.bak 生成；写后可解析', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-cfg-'))
    const file = join(dir, 'config.json')
    writeFileSync(
      file,
      `{\n  // 用户注释要保留\n  "unknownFuture": { "deep": true },\n  "maxIterations": 50,\n  "default": { "provider": "astron", "model": "glm-4.6" }\n}\n`,
      'utf8',
    )
    await saveConfigKey('default.model', 'glm-4.6v', { configPath: file })
    const out = readFileSync(file, 'utf8')
    expect(out).toContain('// 用户注释要保留')
    expect(out).toContain('"unknownFuture"')
    expect(out).toContain('"model": "glm-4.6v"')
    expect(out).not.toContain('"model": "glm-4.6"')
    expect(out).toContain('"maxIterations": 50')
    const bak = readFileSync(`${file}.bak`, 'utf8')
    expect(bak).toContain('"model": "glm-4.6"')
    rmSync(dir, { recursive: true, force: true })
  })
  it('复审 P1-A：默认 CONFIG_TEMPLATE（含尾逗号形态）落盘后可正常保存不误回滚', async () => {
    const { CONFIG_TEMPLATE } = await import('../../src/services/config.js')
    const dir = mkdtempSync(join(tmpdir(), 'ecode-cfg3-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, CONFIG_TEMPLATE, 'utf8')
    await saveConfigKey('maxIterations', 80, { configPath: file })
    const out = readFileSync(file, 'utf8')
    expect(out).toContain('"maxIterations": 80')
    expect(out).toContain('// ') // 注释保留
    rmSync(dir, { recursive: true, force: true })
  })

  it('损坏 config → 抛错且文件不动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-cfg2-'))
    const file = join(dir, 'config.json')
    const broken = '{ "unclosed":'
    writeFileSync(file, broken, 'utf8')
    await expect(saveConfigKey('a', 1, { configPath: file })).rejects.toThrow('解析失败')
    expect(readFileSync(file, 'utf8')).toBe(broken)
    rmSync(dir, { recursive: true, force: true })
  })
})
