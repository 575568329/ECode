/**
 * 沙箱（M9-P4 / M9-D7/D9/D12）：软沙箱——工具层路径/命令校验，进程级围栏后置。
 *
 * 四档（default 档=现状=关，M9-D9 拍板"沙箱有就行，默认不开"）：
 * - default：写/改文件与 bash 每次确认（现状）；无越界分流
 * - read-only：write/edit/bash 全拒（is_error）；读类照常
 * - workspace-write：write/edit 仅 cwd 内（resolve 后前缀校验，天然拦 .. 逃逸）；bash 确认
 * - full-access：全免确认；内置八条危险黑名单（proc.ts，任何档无条件）+
 *   用户可配 sandbox.blockedCommands 通配清单仍硬拒（deny 语义；对齐 CC bypassPermissions）
 *
 * 诚实声明（软沙箱边界）：bash 命令无法可靠解析写目标——read-only 档整体拒绝、其余档靠
 * 确认弹窗兜底，不假装拦得住；进程级 OS 沙箱维持后置（M9-D7）。
 */

import { resolve } from 'node:path'

export type SandboxMode = 'default' | 'read-only' | 'workspace-write' | 'full-access'

export const SANDBOX_MODES: readonly SandboxMode[] = ['default', 'read-only', 'workspace-write', 'full-access']

export type WriteCheck = { ok: true } | { ok: false; reason: string }
export type BashCheck = { action: 'allow' } | { action: 'confirm' } | { action: 'deny'; reason: string }

export interface Sandbox {
  mode: SandboxMode
  /** 写路径校验（write/edit execute 前置）：read-only 拒；workspace-write 仅 cwd 内 */
  checkWrite(absPath: string): WriteCheck
  /** bash 校验：blockedCommands 命中全档硬拒；read-only 拒；full-access 免确认；其余确认 */
  checkBash(command: string): BashCheck
}

/**
 * blockedCommands 通配匹配（`*` 前后缀，语义对齐 opencode wildcard）：
 * "git push --force*" 匹配一切 force push；无 `*` 的模式按前缀匹配（"npm publish" 拦 "npm publish pkg"）。
 */
export function matchesBlocked(command: string, patterns: string[]): boolean {
  const cmd = command.trim()
  return patterns.some((raw) => {
    const pattern = raw.trim()
    if (pattern === '') return false
    const star = pattern.indexOf('*')
    if (star === -1) return cmd.startsWith(pattern)
    const head = pattern.slice(0, star)
    const tail = pattern.slice(star + 1)
    return cmd.startsWith(head) && cmd.endsWith(tail) && cmd.length >= head.length + tail.length
  })
}

export function makeSandbox(mode: SandboxMode, cwd: string, blockedCommands: string[] = []): Sandbox {
  // Windows 大小写不敏感 + 分隔符归一（win32 下 / \ 等价）
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const cwdNorm = norm(resolve(cwd))
  return {
    mode,
    checkWrite(absPath: string): WriteCheck {
      if (mode === 'read-only') return { ok: false, reason: '只读模式（read-only）：文件写入被拒绝。可 /sandbox 切回其他模式。' }
      // resolve 自洽：.. 逃逸在此消化（不依赖调用方先 resolve 的纪律）
      if (mode === 'workspace-write' && !norm(resolve(absPath)).startsWith(`${cwdNorm}/`)) {
        return { ok: false, reason: `workspace-write 模式：仅允许写入工作目录内（${cwd}），越界路径被拒绝。` }
      }
      return { ok: true }
    },
    checkBash(command: string): BashCheck {
      if (matchesBlocked(command, blockedCommands)) {
        return { action: 'deny', reason: `命令命中 blockedCommands 硬拒清单（full-access 也不放行）：${command.trim()}` }
      }
      if (mode === 'read-only') return { action: 'deny', reason: '只读模式（read-only）：bash 命令被拒绝。可 /sandbox 切回其他模式。' }
      if (mode === 'full-access') return { action: 'allow' }
      return { action: 'confirm' }
    },
  }
}

/** 模式循环序列的下一个（Tab 专职热键用；环绕） */
export function nextSandboxMode(mode: SandboxMode): SandboxMode {
  const idx = SANDBOX_MODES.indexOf(mode)
  return SANDBOX_MODES[(idx + 1) % SANDBOX_MODES.length] ?? 'default'
}
