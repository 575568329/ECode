/**
 * config 文件操作（M10-P2）：jsonc 非破坏保存 + 打开配置文件夹。
 * 保存用 jsonc-parser modify/applyEdits（writeWizardConfig 先例——注释/未知键/格式全保留）。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultConfigPath } from './config.js'

/** 打开配置文件夹（explorer/open 现状；$EDITOR+suspend 后置观察区——M4 覆辙不重蹈） */
export function openConfigDir(): void {
  const dir = dirname(defaultConfigPath())
  const cmd = process.platform === 'win32' ? 'explorer' : 'open'
  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打开失败静默（无 GUI 环境等）
  }
}

/** jsonc 非破坏修改单键（点路径 a.b.c；写入前 .bak 一次性备份）。动态 import 避免主路径加载。 */
export async function saveConfigKey(path: string, value: unknown, opts?: { configPath?: string }): Promise<void> {
  const { parse, applyEdits, modify } = await import('jsonc-parser')
  const file = opts?.configPath ?? defaultConfigPath()
  const text = readFileSync(file, 'utf8')
  const errors: import('jsonc-parser').ParseError[] = []
  const tree = parse(text, errors, { allowTrailingComma: true })
  if (tree === undefined || errors.length > 0) {
    throw new Error(`config 解析失败（保存中止，文件未动）：${file}`)
  }
  // .bak 一次性备份（终审 P2-1：existsSync 保证真一次性——保留最早的原始备份不被覆盖）
  const bak = `${file}.bak`
  try {
    if (!existsSync(bak)) copyFileSync(file, bak)
  } catch {
    // 不可写：不阻断
  }
  const jsonPath = path.split('.')
  const edited = modify(text, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  const out = applyEdits(text, edited)
  writeFileSync(file, out, 'utf8')
  // 写后校验可解析（终审 P2-2：失败自动从 .bak 回滚——不留写坏状态给用户）
  const checkErrors: import('jsonc-parser').ParseError[] = []
  const check = parse(out, checkErrors, { allowTrailingComma: true }) // 复审 P1-A：与预检选项对称（默认模板自带尾逗号，缺此选项必误判写坏→误回滚丢编辑）
  if (check === undefined || checkErrors.length > 0) {
    try {
      copyFileSync(bak, file)
    } catch {
      // 回滚失败（无 .bak 等）：报错指路
    }
    throw new Error('保存后校验失败（已尝试从 .bak 回滚——请检查文件状态）')
  }
}
