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

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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
 * 命令/模式归一化分词：按空白切分、剥成对包裹引号、整体小写、首 token 取 basename 去路径前缀
 * 与 .exe 后缀、剥命令包装前缀（env/command/exec…）。
 *
 * Why：纯字符串前缀匹配可被 `"git" push --force`（引号包裹）、`/usr/bin/git push --force`
 * （绝对路径）、`git.exe push --force`（Windows 后缀）、`env git push --force`（包装前缀）、
 * 大小写变体轻松绕过——deny 语义名存实亡。分词归一后按 token 序列比对，这些变体收敛到同一形态。
 */
const COMMAND_WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time'])

function tokenizeCommand(s: string): string[] {
  const tokens: string[] = []
  for (const raw of s.trim().split(/\s+/)) {
    if (raw === '') continue
    let t = raw
    // 剥成对包裹引号（"git" / 'git' → git；只在整 token 成对时剥，避免改变引号内含空格的语义）
    if (
      ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) &&
      t.length >= 2
    ) {
      t = t.slice(1, -1)
    }
    tokens.push(t.toLowerCase())
  }
  // 剥包装前缀（env 附带 VAR=VAL 参数一并跳过——包装后的真实命令才是判定对象）。
  // 首 token 的 basename 归一在循环内做：`/usr/bin/env git push` 的路径形态包装也要吃掉
  const baseOf = (t: string): string => t.replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
  while (tokens.length > 1 && COMMAND_WRAPPERS.has(baseOf(tokens[0] ?? ''))) {
    const isEnv = baseOf(tokens[0] ?? '') === 'env'
    tokens.shift()
    if (isEnv) {
      while (tokens.length > 0 && /^[a-z_][a-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift()
    }
  }
  if (tokens.length > 0) {
    // /usr/bin/git → git（Windows 反斜杠路径同吃）；git.exe → git
    tokens[0] = baseOf(tokens[0] ?? '')
  }
  return tokens
}

/**
 * blockedCommands 通配匹配（语义对齐 opencode wildcard，归一化分词版）：
 * - 模式与命令同样归一化（剥引号/小写/首 token 去路径）
 * - 无 `*` 的模式按 token 序列前缀匹配（"npm publish" 拦 "npm publish pkg"，不误伤 "npm-publish"）
 * - 尾部 `*` 通配：模式末 token 以 `*` 结尾时按前缀匹配该 token（"git push --force*" 拦一切 force 变体）
 * - git push 强推特判：归一后 tokens[0]==='git' 且 push 出现在任意后续位（`git -c a=b
 *   push --force` 全局选项插位、`git --no-pager push` 均覆盖），push 之后的 token 为
 *   -f / --force / --force-with-lease（含 =ref 形态）/ 以 + 开头（强推 refspec）→ 一律命中。
 *   Why：短选项、+refspec、选项插位变体无法靠前缀模式覆盖，deny 清单的核心目标就是拦强推，特判兜底。
 */
export function matchesBlocked(command: string, patterns: string[]): boolean {
  const cmdTokens = tokenizeCommand(command)
  if (cmdTokens.length === 0) return false
  if (cmdTokens[0] === 'git') {
    const pushIdx = cmdTokens.indexOf('push')
    if (pushIdx > 0) {
      const forceHit = cmdTokens.slice(pushIdx + 1).some(
        (t) => t === '-f' || t === '--force' || t.startsWith('--force-with-lease') || t.startsWith('+'),
      )
      if (forceHit) return true
    }
  }
  return patterns.some((raw) => {
    const pattern = raw.trim()
    if (pattern === '') return false
    const pTokens = tokenizeCommand(pattern)
    if (pTokens.length === 0 || pTokens.length > cmdTokens.length) return false
    return pTokens.every((p, i) => (p.endsWith('*') ? cmdTokens[i].startsWith(p.slice(0, -1)) : cmdTokens[i] === p))
  })
}

/**
 * 解析真实路径（消除 symlink/junction 中转）：目标不存在时逐级上溯取最近存在祖先的
 * realpath，再把未存在的尾段拼回（新建嵌套目录下的写文件是常态，一层的 dirname 回退不够）；
 * 上溯到根都不存在（权限/路径异常）返回 undefined，调用方 fail-closed 拒绝——宁可误拒不可越界。
 */
function resolveReal(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    // 目标不存在（或不可读）→ 上溯祖先链
  }
  const tail = [basename(p)] // 未存在尾段从文件名自身起算（不能丢 basename）
  let dir = dirname(p)
  for (;;) {
    try {
      const real = realpathSync(dir)
      return join(real, ...tail.reverse())
    } catch {
      if (dir === dirname(dir)) return undefined // 到根都无法解析：fail-closed
      tail.push(basename(dir))
      dir = dirname(dir)
    }
  }
}

export function makeSandbox(mode: SandboxMode, cwd: string, blockedCommands: string[] = []): Sandbox {
  // Windows 大小写不敏感 + 分隔符归一（win32 下 / \ 等价）
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // cwd 侧也走 realpath：工作目录本身含链接时，词法前缀与真实前缀不一致会整体失效；
  // cwd 解析失败（极罕见）退回词法 resolve，不阻塞沙箱构造
  const cwdNorm = norm(resolveReal(resolve(cwd)) ?? resolve(cwd))
  return {
    mode,
    checkWrite(absPath: string): WriteCheck {
      if (mode === 'read-only') return { ok: false, reason: '只读模式（read-only）：文件写入被拒绝。可 /sandbox 切回其他模式。' }
      // resolve 自洽：.. 逃逸在此消化（不依赖调用方先 resolve 的纪律）；
      // 再叠加 realpath 校验：纯词法前缀拦不住"工作区内指向外部的 symlink/junction"（P2 修复），
      // 展开真实路径后比对才能防越界写
      if (mode === 'workspace-write') {
        const target = resolveReal(resolve(absPath))
        if (target === undefined) {
          return { ok: false, reason: `workspace-write 模式：无法解析真实路径（权限或路径异常，fail-closed 拒绝）：${absPath}` }
        }
        if (!norm(target).startsWith(`${cwdNorm}/`)) {
          return { ok: false, reason: `workspace-write 模式：仅允许写入工作目录内（${cwd}），越界路径（含符号链接逃逸）被拒绝。` }
        }
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
