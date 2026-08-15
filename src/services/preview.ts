/**
 * buildPreview：副作用工具的确认预览内容生成（详设 §7.2，D5）。
 *
 * 在 confirm callback 内部调用（不污染 Tool 接口）。按 use.name 分流（策略 Map）：
 * - edit_file：读原文件 → CRLF 归一化 → createTwoFilesPatch 生成 unified diff
 * - write_file：content 片段（超 40 行截断）
 * - bash：完整命令字符串
 *
 * 返回纯 string（着色由 ConfirmPrompt 渲染层负责）。异常抛出（confirm callback 内 catch，P1#3）。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ToolUseBlock } from '../core/types.js'

/** write_file 预览截断（详设 §4.4） */
const WRITE_PREVIEW_MAX_LINES = 40

export async function buildPreview(use: ToolUseBlock, cwd: string): Promise<string> {
  switch (use.name) {
    case 'edit_file': {
      return buildEditPreview(use, cwd)
    }
    case 'write_file': {
      const input = use.input as { content: string }
      const lines = input.content.split('\n')
      if (lines.length > WRITE_PREVIEW_MAX_LINES) {
        return (
          lines.slice(0, WRITE_PREVIEW_MAX_LINES).join('\n') +
          `\n…（共 ${lines.length} 行，已截断到 ${WRITE_PREVIEW_MAX_LINES}）`
        )
      }
      return input.content
    }
    case 'bash': {
      const input = use.input as { command: string }
      return input.command
    }
    default:
      // MCP 等外部工具（M6 v3 P1-3：盲确认修复——default 分支 pretty-print input，截 40 行）
      return prettyInputPreview(use)
  }
}

/** 外部工具入参预览：pretty JSON，超 40 行截断（用户确认前看得见参数）。 */
function prettyInputPreview(use: ToolUseBlock): string {
  let text: string
  try {
    text = JSON.stringify(use.input ?? {}, null, 2)
  } catch {
    text = String(use.input)
  }
  const lines = text.split('\n')
  if (lines.length > WRITE_PREVIEW_MAX_LINES) {
    return (
      lines.slice(0, WRITE_PREVIEW_MAX_LINES).join('\n') +
      `\n…（共 ${lines.length} 行，已截断到 ${WRITE_PREVIEW_MAX_LINES}）`
    )
  }
  return text === '' ? `(无参数：${use.name})` : `${use.name} 参数：\n${text}`
}

/** edit_file 预览：读原文件 + CRLF 归一化 + unified diff（P1#5 Windows 必踩）。 */
async function buildEditPreview(use: ToolUseBlock, cwd: string): Promise<string> {
  const input = use.input as { path: string; oldString: string; newString: string }
  const abs = isAbsolute(input.path) ? input.path : resolve(cwd, input.path)

  let oldContent: string
  try {
    oldContent = readFileSync(abs, 'utf8')
  } catch (e) {
    throw new Error(
      `读原文件失败 ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // CRLF 归一化（P1#5）：按文件实际换行符转换 oldString/newString，避免 Windows 误报「0 处」
  const nl = oldContent.includes('\r\n') ? '\r\n' : '\n'
  const oldN = input.oldString.replace(/\r?\n/g, nl)
  const newN = input.newString.replace(/\r?\n/g, nl)
  const newContent = oldContent.replace(oldN, newN)

  return createTwoFilesPatch(input.path, input.path, oldContent, newContent, '', '', {
    context: 2,
  })
}
