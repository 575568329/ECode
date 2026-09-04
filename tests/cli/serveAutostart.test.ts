/**
 * serve autostart 启动器构建（纯函数）——win32 专用分支与 dist 守卫。
 * 启动文件夹实跑归真机验证。
 */
import { describe, it, expect } from 'vitest'
import { buildLauncher, AUTOSTART_FILE } from '../../src/cli/serveAutostart.js'

describe('serve autostart 启动器构建', () => {
  it('win32 dist js 入口 → vbs 隐藏启动器（wscript Run windowstyle=0）', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const plan = buildLauncher('D:/app/dist/cli/index.js', 'C:/Program Files/nodejs/node.exe')
      expect(plan.ok).toBe(true)
      if (plan.ok) expect(plan.file.endsWith('\\Startup\\' + AUTOSTART_FILE) || plan.file.endsWith('/Startup/' + AUTOSTART_FILE)).toBe(true)
      if (plan.ok) {
        expect(plan.content).toContain('WScript.Shell')
        expect(plan.content).toContain('""C:\\Program Files\\nodejs\\node.exe"" ""D:\\app\\dist\\cli\\index.js"" serve"')
        expect(plan.content).toContain(', 0, False') // 隐藏 + 不等待
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: orig })
    }
  })
  it('tsx 源码形态拒绝（node 直跑 .ts 不可能）', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const plan = buildLauncher('D:/repo/src/cli/index.ts')
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.reason).toContain('dist')
    } finally {
      Object.defineProperty(process, 'platform', { value: orig })
    }
  })
  it('非 win32 全拒', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(buildLauncher('x.js')).toMatchObject({ ok: false })
    } finally {
      Object.defineProperty(process, 'platform', { value: orig })
    }
  })
})
