/** 沙箱测（M9-P4 + 安全修复）：四档矩阵 + .. 逃逸 + realpath 链接逃逸 + blockedCommands 归一化分词。
 * workspace-write 用例用真实 tmpdir（realpath 校验后假路径会被 fail-closed，测不出放行分支）。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSandbox, matchesBlocked, nextSandboxMode, type SandboxMode } from '../../src/services/sandbox.js'

let root: string
let ws: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ecode-sandbox-'))
  ws = join(root, 'ws')
  mkdirSync(ws)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function sandbox(mode: SandboxMode, blocked: string[] = []): ReturnType<typeof makeSandbox> {
  return makeSandbox(mode, ws, blocked)
}

describe('checkWrite（write/edit 前置校验）', () => {
  it('default / full-access：cwd 内外都放行（确认/免确认在 confirm 层，不归此处）', () => {
    expect(sandbox('default').checkWrite(join(root, 'outside', 'b.ts'))).toEqual({ ok: true })
    expect(sandbox('full-access').checkWrite(join(root, 'outside', 'b.ts'))).toEqual({ ok: true })
  })

  it('read-only：整体拒绝 + 文案含档位', () => {
    const r = sandbox('read-only').checkWrite(join(ws, 'src', 'a.ts'))
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.reason).toContain('read-only')
  })

  it('workspace-write：cwd 内放行（含嵌套新建目录）/ 越界拒绝（最近存在祖先在 ws 外）', () => {
    mkdirSync(join(root, 'other'))
    expect(sandbox('workspace-write').checkWrite(join(ws, 'src', 'a.ts'))).toEqual({ ok: true })
    expect(sandbox('workspace-write').checkWrite(join(ws, 'new-dir', 'sub', 'b.ts'))).toEqual({ ok: true })
    const r = sandbox('workspace-write').checkWrite(join(root, 'other', 'sub', 'b.ts'))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('workspace-write')
  })

  it('.. 逃逸被 resolve 拦（ws/../evil.ts 落到 root，在 ws 外）', () => {
    const r = sandbox('workspace-write').checkWrite(join(ws, '..', 'evil.ts'))
    expect(r.ok).toBe(false)
  })

  it('Windows 大小写归一（大小写变体的真实目录仍算 cwd 内）', ({ skip }) => {
    if (process.platform !== 'win32') skip()
    const r = sandbox('workspace-write').checkWrite(join(ws.toUpperCase(), 'x.ts'))
    expect(r).toEqual({ ok: true })
  })

  it('symlink/junction 越界：工作区内链接指向外部 → realpath 展开后拒写（P2 修复）', () => {
    const vault = join(root, 'vault')
    mkdirSync(vault)
    // Windows 无特权建目录 junction；Unix 普通 symlink
    if (process.platform === 'win32') symlinkSync(vault, join(ws, 'linkdir'), 'junction')
    else symlinkSync(vault, join(ws, 'linkdir'))
    const r = sandbox('workspace-write').checkWrite(join(ws, 'linkdir', 'x.ts'))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('越界')
  })

  it('指向工作区内部的链接不误伤（realpath 后仍在 ws 内 → 放行）', () => {
    mkdirSync(join(ws, 'inner'))
    if (process.platform === 'win32') symlinkSync(join(ws, 'inner'), join(ws, 'self'), 'junction')
    else symlinkSync(join(ws, 'inner'), join(ws, 'self'))
    expect(sandbox('workspace-write').checkWrite(join(ws, 'self', 'y.ts'))).toEqual({ ok: true })
  })
})

describe('checkBash', () => {
  it('default：confirm（现状）；full-access：allow；read-only：deny', () => {
    expect(sandbox('default').checkBash('ls')).toEqual({ action: 'confirm' })
    expect(sandbox('full-access').checkBash('ls')).toEqual({ action: 'allow' })
    expect(sandbox('read-only').checkBash('ls').action).toBe('deny')
  })

  it('accept-edits（界面批 C1）：bash 仍 confirm；blockedCommands 照拒', () => {
    expect(sandbox('accept-edits').checkBash('ls')).toEqual({ action: 'confirm' })
    expect(sandbox('accept-edits', ['rm -rf /']).checkBash('rm -rf /').action).toBe('deny')
  })

  it('accept-edits（界面批 C1）：写路径同 workspace-write——cwd 内放行 / 越界拒', () => {
    mkdirSync(join(root, 'other'))
    expect(sandbox('accept-edits').checkWrite(join(ws, 'src', 'a.ts'))).toEqual({ ok: true })
    const r = sandbox('accept-edits').checkWrite(join(root, 'other', 'sub', 'b.ts'))
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.reason).toContain('accept-edits')
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
})

describe('matchesBlocked（归一化分词：防引号/路径/大小写绕过）', () => {
  const FORCE = ['git push --force*']

  it('审阅样本：每个绕过变体都必须命中', () => {
    const variants = [
      'git push -f',
      '"git" push --force',
      '/usr/bin/git push --force',
      'GIT PUSH --FORCE',
      'git push --force-with-lease origin main',
      'git push origin +main',
      'git push origin +refs/heads/main:main',
      // 复审新增绕过形态：全局选项插位 / .exe 后缀 / 命令包装前缀
      'git -c a=b push --force',
      'git --no-pager push --force',
      'git.exe push --force',
      '/usr/local/bin/git.exe push --force',
      'env git push --force',
      'env VAR=1 git push -f',
      'command git push --force',
      '/usr/bin/env git push --force',
    ]
    for (const cmd of variants) {
      expect(matchesBlocked(cmd, FORCE), cmd).toBe(true)
    }
  })

  it('强推语义收紧的误伤边界：选项插位不影响常规命令', () => {
    // -m 的消息是单个 token（含空格整段引号包裹），不会被当成 push 后的独立 token
    expect(matchesBlocked('git commit -m "push -f"', [])).toBe(false)
    expect(matchesBlocked('git commit -m push', [])).toBe(false)
    expect(matchesBlocked('git status', [])).toBe(false)
    // 包装前缀剥除后是普通命令
    expect(matchesBlocked('env VAR=1 git status', [])).toBe(false)
  })

  it('git push 强推特判不依赖清单（空 patterns 也命中）', () => {
    expect(matchesBlocked('git push -f origin main', [])).toBe(true)
    expect(matchesBlocked('git push origin +main', [])).toBe(true)
  })

  it('普通 git push 不误伤', () => {
    expect(matchesBlocked('git push origin main', [])).toBe(false)
    expect(matchesBlocked('git push origin main', FORCE)).toBe(false)
  })

  it('无 * 模式按 token 序列前缀匹配；不误伤同前缀复合词', () => {
    expect(matchesBlocked('npm publish x', ['npm publish'])).toBe(true)
    expect(matchesBlocked('npm-publish', ['npm publish'])).toBe(false)
    expect(matchesBlocked('gitx push --force', FORCE)).toBe(false)
  })

  it('尾部 * 通配 + 首尾空白归一', () => {
    expect(matchesBlocked('git push --force', FORCE)).toBe(true)
    expect(matchesBlocked('  git push --force-with-lease  ', FORCE)).toBe(true) // 首尾空白归一
    expect(matchesBlocked('git push origin', FORCE)).toBe(false)
  })

  it('模式侧同样归一（绝对路径/大小写模式）', () => {
    expect(matchesBlocked('git push --force', ['/usr/bin/git push --force*'])).toBe(true)
    expect(matchesBlocked('git push --force', ['GIT PUSH --FORCE*'])).toBe(true)
  })

  it('空命令不命中；空模式串不参与匹配', () => {
    expect(matchesBlocked('', FORCE)).toBe(false)
    expect(matchesBlocked('git push origin', [''])).toBe(false)
  })
})

describe('nextSandboxMode（Tab 循环）', () => {
  it('五档环绕（界面批 C1：default→accept-edits→read-only→workspace-write→full-access→default）', () => {
    expect(nextSandboxMode('default')).toBe('accept-edits')
    expect(nextSandboxMode('accept-edits')).toBe('read-only')
    expect(nextSandboxMode('read-only')).toBe('workspace-write')
    expect(nextSandboxMode('workspace-write')).toBe('full-access')
    expect(nextSandboxMode('full-access')).toBe('default')
  })
})
