/**
 * 系统剪贴板图片读取（M10-P2b，Alt+V 粘贴用）。
 *
 * Windows：powershell.exe -Sta 脚本内 Get-Clipboard -Format Image + Save 落 PNG 文件
 * （cmdlet 拿不到原始字节必须脚本内 Save；-Sta 仅 powershell.exe 5.1 支持，显式调它）。
 * macOS：osascript；Linux：xclip（探测链最碎，后置——方案 v1.2 已定 Windows+macOS 先行）。
 * 附件存 ~/.ecode/attachments/<sessionId>/（会话级持久——不放 tmp：随会话清理会断"恢复可读"）。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ClipboardImage {
  /** 落盘后的绝对路径 */
  path: string
  bytes: number
}

const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 3 }
$img.Save($env:Ecode_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
exit 0
`

/** 读剪贴板图片并落盘 PNG（Windows 实现）。无图返回 null（不炸）。 */
export async function readClipboardImage(sessionId: string): Promise<ClipboardImage | null> {
  const dir = join(homedir(), '.ecode', 'attachments', sessionId)
  await mkdir(dir, { recursive: true })
  const out = join(dir, `paste-${Date.now()}.png`)
  try {
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', PS_SCRIPT], {
        env: { ...process.env, Ecode_CLIP_OUT: out },
        timeout: 10_000,
      })
    } else if (process.platform === 'darwin') {
      // osascript 读剪贴板图片写文件（AppleScript 一段；失败即无图）
      await execFileAsync('osascript', ['-e', `set theClipboardImage to the clipboard as «class PNGf»`, '-e', `set outFile to open for access POSIX file "${out}" with write permission`, '-e', 'write theClipboardImage to outFile', '-e', 'close access outFile'], { timeout: 10_000 })
    } else {
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 })
      await writeFile(out, stdout, 'binary')
    }
    const buf = await readFile(out)
    if (buf.length === 0) return null
    return { path: out, bytes: buf.length }
  } catch {
    return null // 无图/读取失败：统一 null（调用方一行提示，不炸不弹窗）
  }
}
