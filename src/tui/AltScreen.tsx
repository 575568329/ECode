/**
 * AltScreen 全屏包装（方案 A 批 1，F-48；CC AlternateScreen 同构，npm ink 无此能力故自实现）。
 *
 * mount：写 DEC 1049 进备用缓冲 + 2J + H 清屏定位 + SGR 鼠标跟踪（滚轮/后续点击）；
 * unmount：反向恢复——主缓冲内容从未离开，原样回来。
 *
 * 时序铁律（架构审阅 P0-3）：进入序列必须写在打开面板的事件处理器里（TuiApp Ctrl+T/
 * setOverlay 之前，同步先于 React 提交）——react-reconciler 的 mutation（Ink 同步画帧）
 * 先于 layout/passive effect，effect 里写 1049h 时第一帧面板已落主缓冲（闪帧+diff 基线
 * 错乱）。本组件的 useInsertionEffect 仅作幂等安全网（flag 判重）。
 *
 * 进程退出兜底：Ink 的 alt 兜底只认它自己的 alternateScreen 标志，旁路进入全责自负——
 * process.on('exit') 内 writeSync 写 1049l（exit 事件里只能同步写，异步写不落地），
 * 防任何崩溃路径把终端困在 alt buffer 黑屏假死。
 *
 * isTTY 守卫：ink-testing 假 stdout 不写序列（防扰动 30+ 测试文件）。
 */
import { useInsertionEffect } from 'react'
import { writeSync } from 'node:fs'

const ENTER = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h'
const EXIT = '\x1b[?1000l\x1b[?1006l\x1b[?1049l'

/** 模块级激活标志：幂等（树内安全网与事件处理器双入口不重复写序列）+exit 兜底判据 */
let altActive = false

function rawWrite(s: string): void {
  // ink-testing 假 stdout（非 TTY）不写；真终端同步写（转义序列必须先于下一帧）
  if (process.stdout.isTTY) process.stdout.write(s)
}

/** 事件处理器入口：打开面板时同步调用（先于 setOverlay 触发的 React 提交）。 */
export function enterAltScreen(): void {
  if (altActive) return
  altActive = true
  rawWrite(ENTER)
}

/** 事件处理器入口：关闭面板时同步调用（先于主树恢复提交）。 */
export function exitAltScreen(): void {
  if (!altActive) return
  altActive = false
  rawWrite(EXIT)
}

export function isAltScreenActive(): boolean {
  return altActive
}

/** 进程级兜底：模块加载时注册一次（exit 内只允许同步写）。 */
let exitHookInstalled = false
export function installAltScreenExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    if (!altActive) return
    try {
      writeSync(1, EXIT)
    } catch {
      /* 终端已关闭等——尽最后努力即可 */
    }
  })
}

export function AltScreen(): null {
  useInsertionEffect(() => {
    // 幂等安全网：事件处理器已写时跳过；直接进面板的路径（如测试/未来入口）由此兜住
    if (!altActive) {
      altActive = true
      rawWrite(ENTER)
    }
    return () => {
      if (altActive) {
        altActive = false
        rawWrite(EXIT)
      }
    }
  }, [])
  return null
}
