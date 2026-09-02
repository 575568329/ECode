/**
 * pty-display-probe 的渲染目标（组件级真 pty 验证——2026-09-02 显示宽度动态化批）：
 * 按 argv 场景渲染 ToolLine / ActivityBar，500ms 后退出（探针抓全量输出断言）。
 * 场景：
 *   preview-<n>   ToolLine 收起预览：bash 输出 n 个 'a' 的单行（验动态截断宽度）
 *   tail-none     ActivityBar thinking：300 个 'x' 无换行（验尾部滚动=右边最新）
 *   tail-newline  ActivityBar thinking：'old line\n' + 短新行（验换行从头显示）
 */
import React from 'react'
import { render } from 'ink'
import { ToolLine } from '../src/tui/ToolLine.js'
import { ActivityBar } from '../src/tui/ActivityBar.js'
import type { ActiveTool } from '../src/tui/types.js'

const scene = process.argv[2] ?? ''

if (scene.startsWith('preview-')) {
  const n = Number(scene.slice('preview-'.length))
  const tool: ActiveTool = {
    name: 'bash',
    use: { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo' } },
    result: { type: 'tool_result', tool_use_id: 't1', content: 'a'.repeat(n) },
    status: 'done',
    at: Date.now(),
  }
  render(React.createElement(ToolLine, { tool, mode: 'dynamic' }))
} else if (scene === 'tail-none') {
  render(React.createElement(ActivityBar, { state: 'thinking', detail: 'x'.repeat(300) }))
} else if (scene === 'tail-newline') {
  render(React.createElement(ActivityBar, { state: 'thinking', detail: `old line ${'o'.repeat(200)}\nshort new line ok` }))
} else {
  process.stderr.write(`unknown scene: ${scene}\n`)
  process.exit(2)
}

setTimeout(() => process.exit(0), 600)
