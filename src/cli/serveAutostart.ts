/**
 * `ecode serve autostart`（2026-09-04 用户点名）：把 serve 注册成**登录自启**的常驻进程——
 * 手机/远程接入不再依赖「每次手动起 serve」。
 *
 * Windows 实现：用户「启动」文件夹放隐藏启动器（.vbs + wscript Run windowstyle=0）——
 * 登录时静默拉起 `ecode serve`。无管理员权限要求（schtasks ONLOGON 需 admin，实测拒绝访问）；
 * 文件在开始菜单启动文件夹可见、删除即卸载，痕迹透明。
 *
 * 入口解析自当前模块位置——dist 形态（npm link 全局）才可注册，tsx 源码形态拒绝
 * （node 直跑 .ts 不可能）。非 Windows 打印 systemd user unit 指引。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'

export const AUTOSTART_FILE = 'ECodeServe.vbs'

/** 当前 CLI 入口脚本绝对路径（dist 形态 = .../dist/cli/index.js）。 */
export function cliEntryPath(): string {
  const here = fileURLToPath(import.meta.url) // .../dist/cli/serveAutostart.js
  return join(dirname(here), 'index.js')
}

/** 用户「启动」文件夹（登录自动运行）。 */
export function startupDir(): string {
  const appData = process.env.APPDATA
  if (appData === undefined || appData === '') throw new Error('APPDATA 未设置（非 Windows 环境）')
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

export function autostartFilePath(): string {
  return join(startupDir(), AUTOSTART_FILE)
}

export type AutostartPlan = { ok: true; file: string; content: string } | { ok: false; reason: string }

/** 生成启动器内容（纯函数可测；win32 专用——调用方保证平台）。 */
/**
 * 生成启动器内容（纯函数可测；win32 专用——调用方保证平台）。
 * workDir = serve 的工作目录（注册默认项目/读 .env 的基准）——取安装时的 cwd，
 * 保持与手动 `ecode serve` 完全一致；启动文件夹的默认 cwd 是系统目录，不可直接用。
 */
export function buildLauncher(entryJs: string, workDir: string, nodeExe = process.execPath): AutostartPlan {
  if (process.platform !== 'win32') return { ok: false, reason: '仅 Windows 支持（非 Windows 请用 systemd user unit / launchd）' }
  if (!entryJs.endsWith('.js')) {
    return { ok: false, reason: 'autostart 需要 dist 形态：先 npm run build 再 npm link（tsx 源码形态无法被登录自启直跑）' }
  }
  const bs = (v: string): string => v.replace(/\//g, '\\')
  // 行1：CurrentDirectory 指向安装时的目录（serve 注册默认项目/读 .env 的基准与手动一致）；
  // 行2：wscript Run 第二参 0 = 隐藏窗口，False = 不等待（serve 长驻）
  const content = [
    `CreateObject("WScript.Shell").CurrentDirectory = "${bs(workDir)}"`,
    `CreateObject("WScript.Shell").Run """${bs(nodeExe)}"" ""${bs(entryJs)}"" serve", 0, False`,
  ].join('\n')
  return { ok: true, file: autostartFilePath(), content }
}

export function planForThisInstall(): AutostartPlan {
  return buildLauncher(cliEntryPath(), process.cwd())
}

/** `ecode serve autostart`：安装登录自启（幂等覆盖）。 */
export async function autostartInstall(): Promise<void> {
  const plan = planForThisInstall()
  if (!plan.ok) {
    process.stderr.write(`✗ ${plan.reason}\n`)
    process.exit(1)
  }
  try {
    mkdirSync(dirname(plan.file), { recursive: true })
    writeFileSync(plan.file, plan.content, 'utf8')
  } catch (e) {
    process.stderr.write(`✗ 写入启动器失败：${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
  process.stdout.write(`✓ 已注册登录自启（登录时静默 ecode serve，绑定 127.0.0.1）\n  启动器：${plan.file}\n  状态：ecode serve autostart --status\n  移除：ecode serve autostart --remove\n`)
}

/** `ecode serve autostart --remove`。 */
export function autostartRemove(): void {
  const f = autostartFilePath()
  if (!existsSync(f)) {
    process.stdout.write('（未注册——本就没有启动器）\n')
    return
  }
  try {
    unlinkSync(f)
    process.stdout.write('✓ 已移除登录自启启动器\n')
  } catch (e) {
    process.stderr.write(`✗ 移除失败：${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
}

/** `ecode serve autostart --status`：exit 0=已注册，1=未注册。 */
export function autostartStatus(): void {
  const f = autostartFilePath()
  if (existsSync(f)) {
    process.stdout.write(`✓ 已注册（${f}）\n`)
    return
  }
  process.stdout.write('✗ 未注册（登录时不会自动起 serve）\n')
  process.exit(1)
}
