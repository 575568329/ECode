/**
 * pty-display-probe 的渲染目标（组件级真 pty 验证——2026-09-02 显示宽度动态化批）：
 * 按 argv 场景渲染 ToolLine / ActivityBar，500ms 后退出（探针抓全量输出断言）。
 * 场景：
 *   preview-<n>   ToolLine 收起预览：bash 输出 n 个 'a' 的单行（验动态截断宽度）
 *   tail-none     ActivityBar thinking：300 个 'x' 无换行（验尾部滚动=右边最新）
 *   tail-newline  ActivityBar thinking：'old line\n' + 短新行（验换行从头显示）
 *   status-*      StatusBar 精简批（2026-09-02）：full=全段 / narrow=丢段 / slim=只留
 *                 model / hint=App 同行组合（busy 提示占宽参与守卫）
 */
import React from 'react'
import { render } from 'ink'
import { Text, Box } from 'ink'
import stringWidth from 'string-width'
import { ToolLine } from '../src/tui/ToolLine.js'
import { ActivityBar } from '../src/tui/ActivityBar.js'
import { StatusBar } from '../src/tui/StatusBar.js'
import { BUSY_HINT } from '../src/tui/ShortcutHint.js'
import type { ActiveTool } from '../src/tui/types.js'

const scene = process.argv[2] ?? ''

const STATUSBAR_PROPS = {
  model: 'glm-5.3-flash',
  iter: 3,
  maxIter: 25,
  tokens: 45_000,
  ctxUsed: 45_000,
  ctxWindow: 200_000,
  cost: '¥0.003',
  mcp: 'MCP 2/3',
  sandbox: 'accept-edits',
  memBytes: 350 * 1024 ** 2,
  daemon: '后台运行',
} as const

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
} else if (scene.startsWith('status-')) {
  const mode = scene.slice('status-'.length)
  if (mode === 'full' || mode === 'narrow' || mode === 'slim') {
    render(React.createElement(StatusBar, { ...STATUSBAR_PROPS }))
  } else if (mode === 'hint') {
    // 复刻 App 底行组合：StatusBar + busy 提示同行（reserveWidth=提示实占）
    const reserve = stringWidth(` · ${BUSY_HINT}`)
    render(
      React.createElement(Box, null,
        React.createElement(StatusBar, { ...STATUSBAR_PROPS, reserveWidth: reserve }),
        React.createElement(Text, { dimColor: true }, ` · ${BUSY_HINT}`),
      ),
    )
  } else {
    process.stderr.write(`unknown status mode: ${mode}\n`)
    process.exit(2)
  }
} else {
  process.stderr.write(`unknown scene: ${scene}\n`)
  process.exit(2)
}

setTimeout(() => process.exit(0), 600)
