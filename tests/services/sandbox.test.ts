/** 沙箱测（M9-P4）：四档矩阵 + .. 逃逸 + blockedCommands 通配（纯函数，无 IO）。 */
import { describe, it, expect } from 'vitest'
import { makeSandbox, matchesBlocked, nextSandboxMode, type SandboxMode } from '../../src/services/sandbox.js'

const CWD = process.platform === 'win32' ? 'D:/work/proj' : '/home/u/proj'
const inside = `${CWD}/src/a.ts`
const outside = process.platform === 'win32' ? 'E:/other/b.ts' : '/etc/passwd'

function sandbox(mode: SandboxMode, blocked: string[] = []): ReturnType<typeof makeSandbox> {
  return makeSandbox(mode, CWD, blocked)
}

describe('checkWrite（write/edit 前置校验）', () => {
  it('default / full-access：cwd 内外都放行（确认/免确认在 confirm 层，不归此处）', () => {
    expect(sandbox('default').checkWrite(outside)).toEqual({ ok: true })
    expect(sandbox('full-access').checkWrite(outside)).toEqual({ ok: true })
  })

  it('read-only：整体拒绝 + 文案含档位', () => {
    const r = sandbox('read-only').checkWrite(inside)
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.reason).toContain('read-only')
  })

  it('workspace-write：cwd 内放行 / 越界拒绝', () => {
    expect(sandbox('workspace-write').checkWrite(inside)).toEqual({ ok: true })
    const r = sandbox('workspace-write').checkWrite(outside)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('workspace-write')
  })

  it('.. 逃逸被 resolve 拦（D:/work/proj/../evil 在 proj 外）', () => {
    const esc = `${CWD}/../evil.ts`
    // 注：makeSandbox 校验基于调用方传入的 resolve 后路径；此处直接给"未 resolve 的形态"验证前缀比较不吃 ..（等价于已 resolve 的越界结果）
    const r = sandbox('workspace-write').checkWrite(esc)
    expect(r.ok).toBe(false)
  })

  it('Windows 大小写与反斜杠归一（d:/WORK/proj 仍算 cwd 内）', () => {
    const r = sandbox('workspace-write').checkWrite('D:\\WORK\\proj\\x.ts')
    expect(r).toEqual({ ok: true })
  })
})

describe('checkBash', () => {
  it('default：confirm（现状）；full-access：allow；read-only：deny', () => {
    expect(sandbox('default').checkBash('ls')).toEqual({ action: 'confirm' })
    expect(sandbox('full-access').checkBash('ls')).toEqual({ action: 'allow' })
    expect(sandbox('read-only').checkBash('ls').action).toBe('deny')
  })

  it('blockedCommands 通配：全档硬拒（含 full-access）', () => {
    const blocked = ['git push --force*', 'npm publish*', 'rm -rf /']
    for (const mode of ['default', 'full-access'] as const) {
      const r = sandbox(mode, blocked).checkBash('git push --force origin main')
      expect(r).toMatchObject({ action: 'deny' })
      expect(r.action === 'deny' && r.reason).toContain('blockedCommands')
    }
    expect(sandbox('full-access', blocked).checkBash('npm publish mypkg').action).toBe('deny')
    expect(sandbox('full-access', blocked).checkBash('npm install').action).toBe('allow')
  })

  it('blocked 无 * 模式按前缀匹配；* 尾通配不误伤同前缀短命令', () => {
    expect(matchesBlocked('npm publish x', ['npm publish'])).toBe(true)
    expect(matchesBlocked('npm-publish', ['npm publish'])).toBe(false)
    expect(matchesBlocked('git push --force', ['git push --force*'])).toBe(true)
    expect(matchesBlocked('git push origin', ['git push --force*'])).toBe(false)
    expect(matchesBlocked('  git push --force-with-lease  ', ['git push --force*'])).toBe(true) // 首尾空白归一
  })
})

describe('nextSandboxMode（Tab 循环）', () => {
  it('四档环绕', () => {
    expect(nextSandboxMode('default')).toBe('read-only')
    expect(nextSandboxMode('read-only')).toBe('workspace-write')
    expect(nextSandboxMode('workspace-write')).toBe('full-access')
    expect(nextSandboxMode('full-access')).toBe('default')
  })
})
