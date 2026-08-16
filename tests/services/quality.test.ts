/**
 * QualityGate 测（M9-P3）：runner 全 mock（不跑真命令）；探测用 tmpdir 真 package.json。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QualityGate, detectQualityCommands, type QualityRunOutcome } from '../../src/services/quality.js'

const warn = vi.fn()

function makeGate(outcomes: Array<QualityRunOutcome | Error>, commands: { lint?: string; test?: string } = { lint: 'npm run lint' }): {
  gate: QualityGate
  run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn(async (): Promise<QualityRunOutcome> => {
    const next = outcomes.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('mock 用尽')
    return next
  })
  const gate = new QualityGate({ commands, run, warn })
  return { gate, run }
}

const EDIT = [{ name: 'edit_file', isError: false }]
const READ = [{ name: 'read_file', isError: false }]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecode-quality-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('detectQualityCommands（探测）', () => {
  it('package.json scripts 探测命中 lint/test', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }))
    expect(detectQualityCommands(dir)).toEqual({ lint: 'npm run lint', test: 'npm run test' })
  })

  it('探测不到（无 package.json / 无 scripts）→ 关闭', () => {
    expect(detectQualityCommands(dir)).toEqual({})
  })

  it('config 显式覆盖优先；只覆盖一半则另一半探测', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    expect(detectQualityCommands(dir, { lintCommand: 'biome check' })).toEqual({ lint: 'biome check', test: 'npm run test' })
  })
})

describe('QualityGate（轮末聚合回喂）', () => {
  it('非编辑轮不跑（只读工具）', async () => {
    const { gate, run } = makeGate([])
    expect(await gate.afterRound(READ)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('编辑失败（isError）不触发', async () => {
    const { gate, run } = makeGate([])
    expect(await gate.afterRound([{ name: 'edit_file', isError: true }])).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('编辑成功 + lint 失败 → [lint] 回喂文本；全绿静默并重置', async () => {
    const { gate } = makeGate([
      { command: 'npm run lint', exitCode: 1, output: 'src/a.ts:1 error' },
      { command: 'npm run lint', exitCode: 0, output: '' },
    ])
    const fb = await gate.afterRound(EDIT)
    expect(fb).toContain('[lint] npm run lint 失败（exit 1）')
    expect(fb).toContain('src/a.ts:1 error')
    expect(fb).toContain('[quality] 请修复')
    expect(await gate.afterRound(EDIT)).toBeUndefined() // 修复后全绿
  })

  it('runner 抛错 → 启动失败回喂不炸', async () => {
    const { gate } = makeGate([new Error('spawn ENOENT')])
    const fb = await gate.afterRound(EDIT)
    expect(fb).toContain('启动失败')
    expect(fb).toContain('spawn ENOENT')
  })

  it('连续 2 次输出无变化 → 熔断：本次仍回喂（带熔断提示）+ warn + 此后短路', async () => {
    const { gate } = makeGate([
      { command: 'npm run lint', exitCode: 1, output: 'same error' },
      { command: 'npm run lint', exitCode: 1, output: 'same error' },
      { command: 'npm run lint', exitCode: 1, output: 'same error' },
    ])
    const fb1 = await gate.afterRound(EDIT)
    expect(fb1).toContain('请修复')
    expect(gate.tripped).toBe(false)
    const fb2 = await gate.afterRound(EDIT)
    expect(fb2).toContain('已连续 2 次修复无效')
    expect(fb2).toContain('请仔细分析')
    expect(gate.tripped).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('停止自动运行'))
    expect(await gate.afterRound(EDIT)).toBeUndefined() // 熔断后短路
  })

  it('输出有变化（模型在修）→ 计数重置不熔断', async () => {
    const { gate } = makeGate([
      { command: 'npm run lint', exitCode: 1, output: 'error A' },
      { command: 'npm run lint', exitCode: 1, output: 'error B（变少了）' },
      { command: 'npm run lint', exitCode: 1, output: 'error B（变少了）' },
    ])
    await gate.afterRound(EDIT)
    const fb2 = await gate.afterRound(EDIT)
    expect(gate.tripped).toBe(false) // 第二次输出有变化 → 计数 1
    const fb3 = await gate.afterRound(EDIT) // 第三次同输出 → 计数 2 → 熔断
    expect(gate.tripped).toBe(true)
    expect(fb3).toContain('已连续 2 次')
    expect(fb2).toBeTruthy()
  })

  it('lastRoundFailed（终审 P1-5：autoCommit 红灯判据）——失败 true / 全绿与未编辑轮 false', async () => {
    const { gate } = makeGate([
      { command: 'npm run lint', exitCode: 1, output: 'err' },
      { command: 'npm run lint', exitCode: 0, output: '' },
    ])
    await gate.afterRound(EDIT)
    expect(gate.lastRoundFailed).toBe(true)
    await gate.afterRound(EDIT) // 全绿
    expect(gate.lastRoundFailed).toBe(false)
    await gate.afterRound(READ) // 未编辑轮（不跑）
    expect(gate.lastRoundFailed).toBe(false)
  })

  it('commands 全空 → disabled 短路', async () => {
    const { gate, run } = makeGate([], {})
    expect(gate.disabled).toBe(true)
    expect(await gate.afterRound(EDIT)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('长输出截断（头尾保留 + 截断提示）', async () => {
    const long = 'X'.repeat(10_000)
    const { gate } = makeGate([{ command: 'npm run lint', exitCode: 1, output: long }])
    const fb = (await gate.afterRound(EDIT)) ?? ''
    expect(fb.length).toBeLessThan(6_000)
    expect(fb).toContain('中间已截断')
  })
})
