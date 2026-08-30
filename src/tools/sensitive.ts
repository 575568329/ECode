/**
 * 敏感路径公共守卫（安全审阅 P0 密钥外传链封堵）。
 *
 * Why 集中一处：门只装 read_file 单点时，grep 直读 ~/.ecode/config.json 可完整旁路
 * （复审 P0 重放实证）——所有会读文件**内容**的工具必须共用同一判定与文案；
 * 新增读类工具时接入 sensitiveGate（文件直读）或 isSensitivePath（目录游走逐文件过滤）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * 敏感路径集合。basename 前缀命中 .env（覆盖 .env / .env.local / .env.production 等，
 * 从紧——.envrc 类同拦不误放）或 id_rsa；后缀命中 .pem；精确名命中常见凭据文件
 * （.netrc/.npmrc/_authToken/credentials/secrets.*，复审补充清单）；目录围栏：homedir 下
 * .ecode（config.json 的 apiKey）/.ssh（全部密钥材料）/.aws/.config/gcloud（云凭据）。
 * 判定大小写不敏感（Windows 文件系统不区分，攻击面从紧）。
 */
const SENSITIVE_BASENAME_PREFIXES = ['.env', 'id_rsa']
const SENSITIVE_BASENAME_SUFFIXES = ['.pem']
const SENSITIVE_BASENAME_EXACT = new Set([
  '.netrc',
  '.npmrc',
  'credentials',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
  'secrets.toml',
  // 审阅 S-P2 补充：home 级持久化向量（hooks 别名/core.hooksPath 注入）——编辑照卡
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.gitconfig',
])
const SENSITIVE_HOME_SUBDIRS = ['.ecode', '.ssh', '.aws', '.config/gcloud']

/** 词法判定（basename / homedir 围栏，见下方清单注释）。 */
function isSensitiveLexical(abs: string): boolean {
  const base = path.basename(abs).toLowerCase()
  if (SENSITIVE_BASENAME_PREFIXES.some((p) => base.startsWith(p))) return true
  if (SENSITIVE_BASENAME_SUFFIXES.some((s) => base.endsWith(s))) return true
  if (SENSITIVE_BASENAME_EXACT.has(base)) return true
  const home = os.homedir()
  return SENSITIVE_HOME_SUBDIRS.some((dir) => {
    // path.relative 判定包含关系：空串=目录本身、.. 开头=在目录外、绝对串=跨盘符
    const rel = path.relative(path.join(home, dir), abs)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

/** 真实路径解析：readFile 物理跟随 symlink/junction，纯词法围栏挡不住链接穿透
 *  （复审 P0 实证：项目内 junction → ~/.ecode 经 read_file 原文读到 apiKey）。
 *  解析失败（文件不存在/权限）返回原词法路径——此时读取本身会失败，无泄露面。 */
function withRealPath(abs: string): string {
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

/** 解析后的路径是否命中敏感集合（词法+真实路径双判，任一命中即敏感——防链接中转绕过围栏）。 */
export function isSensitivePath(abs: string): boolean {
  return isSensitiveLexical(abs) || isSensitiveLexical(withRealPath(abs))
}

/**
 * 清账批 III P0-1：项目级 `.ecode/settings*`（含 settings.local.json）敏感判定。
 * isSensitivePath 的 `.ecode` 围栏只挂 homedir 下——cwd 内的 `.ecode/settings.local.json`
 * 是权限规则文件（accept-edits 档写它 = hook 自授权链），accept-edits 直放分支单独引用
 * 本判定照卡（不全局改 isSensitivePath，避免误伤项目内普通 .ecode 文件的既有放行口径）。
 * 判定：任一级段为 `.ecode` 且 basename 以 `settings` 开头。
 */
export function isProjectEcodeSettings(abs: string): boolean {
  const parts = abs.split(/[\\/]+/).filter((p) => p !== '')
  const hasEcodeDir = parts.slice(0, -1).some((p) => p.toLowerCase() === '.ecode')
  const base = parts[parts.length - 1] ?? ''
  return hasEcodeDir && base.toLowerCase().startsWith('settings')
}

/** 统一敏感门：不敏感或用户已确认 → undefined（放行）；拒绝 → is_error 文案。 */
export async function sensitiveGate(
  abs: string,
  ctx: { confirmSensitive?: (description: string) => Promise<boolean | string> },
  toolName: string,
): Promise<{ content: string; is_error: true } | undefined> {
  if (!isSensitivePath(abs)) return undefined
  // 有确认通路（TUI）→ 弹窗问用户；确认回调自身异常会冒泡到 loop 的 invokeTool
  // 兜底为 recoverable is_error（UI 层错误 → 工具错误反馈）
  if (ctx.confirmSensitive !== undefined) {
    const allowed = await ctx.confirmSensitive(`${toolName} 读取敏感路径 ${abs}`)
    // string=带反馈的拒绝（对标 A1：模型知道为什么被拒可换方法）；false=无名拒绝
    if (allowed === true) return undefined
    const reason = typeof allowed === 'string' && allowed !== '' ? `（原因：${allowed}）` : ''
    return { content: `用户已拒绝读取敏感路径 ${abs}${reason}`, is_error: true }
  }
  // 无确认通路（argv 无头模式）fail-closed——宁拦勿泄
  return {
    content: `敏感路径 ${abs} 需用户确认后可读；当前模式无法弹窗已拒绝（fail-closed）。请让用户改用交互模式，或由用户自行粘贴所需内容`,
    is_error: true,
  }
}
