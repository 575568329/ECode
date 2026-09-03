/**
 * pty-display-probe 的渲染目标（组件级真 pty 验证——2026-09-02 显示宽度动态化批）：
 * 按 argv 场景渲染 ToolLine / ActivityBar，500ms 后退出（探针抓全量输出断言）。
 * 场景：
 *   preview-<n>   ToolLine 收起预览：bash 输出 n 个 'a' 的单行（验动态截断宽度）
 *   tail-none     ActivityBar thinking：300 个 'x' 无换行（验尾部滚动=右边最新）
 *   tail-newline  ActivityBar thinking：'old line\n' + 短新行（验换行从头显示）
 *   status-*      StatusBar 精简批（2026-09-02）：full=全段 / narrow=丢段 / slim=只留
 *                 model / hint=App 同行组合（busy 提示占宽参与守卫）
 *   rss-stream    批2c RSS 探针（P1-A）：真 TimelineView 长流自压——20ms delta × 25KB×3 轮，
 *                 stderr 自报 MEM=/TURN_END=/FINAL= 标记（pty-rss-probe.cjs 断言峰值/回落）
 */
import React from 'react'
import { render } from 'ink'
import { Text, Box } from 'ink'
import stringWidth from 'string-width'
import { ToolLine } from '../src/tui/ToolLine.js'
import { ActivityBar } from '../src/tui/ActivityBar.js'
import { StatusBar } from '../src/tui/StatusBar.js'
import { TimelineView } from '../src/tui/TimelineView.js'
import { ToolGroupView } from '../src/tui/ToolGroupView.js'
import { foldStreamText } from '../src/tui/stream.js'
import { BUSY_HINT } from '../src/tui/ShortcutHint.js'
import type { ActiveTool } from '../src/tui/types.js'
import { useEffect, useRef, useState } from 'react'
import { writeHeapSnapshot } from 'node:v8'

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
} else if (scene === 'rss-stream' || scene === 'rss-pure' || scene === 'rss-ink') {
  // 批2c：RSS 探针目标——真 TimelineView（含 GrayStreaming 增量折叠路径）长流自压。
  // 3 轮 × 25KB（每 20ms 追加 10 中文字 + 每 50 tick 混一个换行——超宽连续段与逻辑行混合形态）；
  // 标记走 stderr（与 Ink 的 stdout 帧流分离，探针好解析）。
  // 二分变体（泄漏定位用）：rss-pure=纯 foldStreamText 无 Ink（缓存层）；rss-ink=裸 Ink
  // Text 重渲无 TimelineView（React/Ink 层）；rss-stream=完整路径
  const CHARS_PER_TICK = 10
  const TICKS_PER_TURN = Number(process.env.RSS_TICKS ?? 1250) // 12500 字/轮 ≈ 25KB（探针可缩短做吞吐诊断）
  const TURNS = Number(process.env.RSS_TURNS ?? 3)
  function RssApp(): React.ReactElement {
    const [text, setText] = useState('')
    const grayCacheRef = useRef<{ current: import('../src/tui/stream.js').StreamFoldCache | null }>({ current: null })
    useEffect(() => {
      let tick = 0
      let turn = 0
      const timer = setInterval(() => {
        tick++
        setText((t) => t + '中'.repeat(CHARS_PER_TICK) + (tick % 50 === 0 ? '\n' : ''))
        if (tick % 100 === 0) {
          const m = process.memoryUsage()
          process.stderr.write(`MEM=${(m.rss / 1048576).toFixed(1)}/${(m.heapUsed / 1048576).toFixed(1)}\n`)
        }
        if (tick >= TICKS_PER_TURN) {
          turn++
          const m = process.memoryUsage()
          process.stderr.write(`TURN_END=${turn} MEM=${(m.rss / 1048576).toFixed(1)}/${(m.heapUsed / 1048576).toFixed(1)}\n`)
          // 批2c 判别器：轮末强制 GC（--expose-gc 下 global.gc 存在）后采样——GC 后仍逐轮
          // 爬升=真保留型泄漏；掉回基线=懒 GC 未收的垃圾（非泄漏）。探针棘轮断言以此为准
          const g = (globalThis as { gc?: () => void }).gc
          if (typeof g === 'function') {
            g()
            const mg = process.memoryUsage()
            process.stderr.write(`TURN_GC=${turn} MEM=${(mg.rss / 1048576).toFixed(1)}/${(mg.heapUsed / 1048576).toFixed(1)}\n`)
            // 诊断档（RSS_SNAPSHOT=1 且第 2 装轮）：GC 后落堆快照——活对象按构造器聚合定位保留源
            if (process.env.RSS_SNAPSHOT === '1' && turn === 2) {
              const file = writeHeapSnapshot(process.cwd() + '/rss-snap.heapsnapshot')
              process.stderr.write(`SNAPSHOT=${file}\n`)
            }
          }
          tick = 0
          setText('')
          if (turn >= TURNS) {
            clearInterval(timer)
            // GC 窗口：末轮后 8s 再采样（V8 懒回收——轮末即刻采样必不回落）
            setTimeout(() => {
              const m = process.memoryUsage()
              process.stderr.write(`FINAL=${(m.rss / 1048576).toFixed(1)}/${(m.heapUsed / 1048576).toFixed(1)}\n`)
              process.exit(0)
            }, 8000)
          }
        }
      }, 20)
      return () => clearInterval(timer)
    }, [])
    if (scene === 'rss-ink') {
      // 二分：裸 Ink——只重渲一个 Text（无 TimelineView/fold）
      return React.createElement(Text, { dimColor: true }, text.slice(-200))
    }
    if (process.env.RSS_MINI === '1') {
      // 二分：MiniGray——只挂 GrayStreaming 同款 fold（RSS_NO_CACHE=1 用旧全量路径对照）
      const noCache = process.env.RSS_NO_CACHE === '1'
      const r = noCache ? foldStreamText(text, 4, 78) : foldStreamText(text, 4, 78, grayCacheRef.current)
      return React.createElement(Text, { dimColor: true }, r.lines.join('\n'))
    }
    return React.createElement(TimelineView, {
      timeline: [{ kind: 'text', id: 'live-1', text, live: true }],
      lines: 30,
      liveMaxLines: 4,
    })
  }
  if (scene === 'rss-pure') {
    // 二分：无 Ink——纯 foldStreamText + cache（含轮末 GC 采样），不 render 任何东西
    let text = ''
    let tick = 0
    let turn = 0
    const cacheBox = { current: null } as { current: import('../src/tui/stream.js').StreamFoldCache | null }
    const timer = setInterval(() => {
      tick++
      text += '中'.repeat(CHARS_PER_TICK) + (tick % 50 === 0 ? '\n' : '')
      foldStreamText(text, 4, 78, cacheBox)
      if (tick >= TICKS_PER_TURN) {
        turn++
        const g = (globalThis as { gc?: () => void }).gc
        if (typeof g === 'function') g()
        const m = process.memoryUsage()
        process.stderr.write(`TURN_GC=${turn} MEM=${(m.rss / 1048576).toFixed(1)}/${(m.heapUsed / 1048576).toFixed(1)}\n`)
        tick = 0
        text = ''
        cacheBox.current = null
        if (turn >= TURNS) {
          clearInterval(timer)
          setTimeout(() => process.exit(0), 1000)
        }
      }
    }, 20)
  } else {
    render(React.createElement(RssApp))
  }
} else if (scene === 'toolrun-dyn' || scene === 'toolrun-static') {
  // 同名工具折叠批（2026-09-03 用户拍板「相同的工具能折叠也折叠」）：真 pty 断言
  // 动态区 run 折叠（×N 摘要 + 最新完整）与静态紧凑组（×N 组头 + 单行/条 + 还有 N 条）。
  // digest 带 cd 前缀长命令——顺带压紧凑行 clipWidth 真实性（无 wrap 溢出由探针断言）
  const dynEntries = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((id) => ({
    kind: 'tool' as const,
    id,
    tool: {
      name: 'bash',
      id,
      status: 'done' as const,
      digest: `cd D:/Study/ECode && grep -rn "kw-${id}" web/src/`,
      content: `web/src/store.ts:1${id}: appendUser hit-${id} ——一段够长的中文输出以压 preview 截断${'余'.repeat(40)}`,
    },
  }))
  if (scene === 'toolrun-dyn') {
    render(React.createElement(TimelineView, { timeline: dynEntries, lines: 14, liveMaxLines: 4 }))
  } else {
    const tools = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({
      name: 'bash',
      use: { type: 'tool_use' as const, id: `u-${id}`, name: 'bash', input: { command: `cmd-${id}` } },
      result: {
        type: 'tool_result' as const,
        tool_use_id: `u-${id}`,
        content: `web/src/store.ts:1${id}: appendUser hit-${id} ——一段够长的中文输出以压 preview 截断${'余'.repeat(40)}`,
      },
      status: 'done' as const,
      digest: `cd D:/Study/ECode && grep -rn "kw-${id}" web/src/`,
    }))
    render(React.createElement(ToolGroupView, { tools }))
  }
} else {
  process.stderr.write(`unknown scene: ${scene}\n`)
  process.exit(2)
}

if (!scene.startsWith('rss-')) setTimeout(() => process.exit(0), 600)
