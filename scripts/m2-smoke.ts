/**
 * M2 第 0 步前置烟测（基础部分，Bash 非 TTY 下可跑）。
 * useInput/useFocus/Ctrl+C/滚动 需真实 TTY（Bash 下跳过，标注）。
 */
import { render, Box, Text, Static } from 'ink'
import stringWidth from 'string-width'
import { performance } from 'node:perf_hooks'
import React from 'react'

console.log('=== [1] ESM import ===')
console.log('ink / react / string-width import OK')

console.log('\n=== [2] string-width 中文宽度 ===')
console.log('stringWidth("中文a") =', stringWidth('中文a'), '(期望 5)')
console.log('stringWidth("👨‍👩‍👧") =', stringWidth('👨‍👩‍👧'), '(字素)')

console.log('\n=== [3] Ink 基础渲染（纯 Box/Text，不用 useInput）===')
const { unmount: u1 } = render(
  React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { color: 'cyan' }, 'ECode M2 烟测'),
  ),
)
console.log('Ink render(Box/Text) OK')
u1()

console.log('\n=== [4] Static 性能（200/500/1000 条 render 耗时）===')
for (const n of [200, 500, 1000]) {
  const items = Array.from({ length: n }, (_, i) => `第 ${i} 条历史消息`)
  const t0 = performance.now()
  const { unmount } = render(
    React.createElement(Static, { items }, (s) =>
      React.createElement(Text, { key: s }, s),
    ),
  )
  const t1 = performance.now()
  unmount()
  console.log(`Static ${n} 条 render: ${(t1 - t0).toFixed(1)}ms ${t1 - t0 < 100 ? '✓' : '⚠️ 超 100ms'}`)
}

console.log('\n=== [5] 需真实 TTY 验证（Bash 下跳过）===')
console.log('- useInput / useFocus（raw mode stdin，Bash 不支持）')
console.log('- Ctrl+C + AbortSignal 中断流式')
console.log('- 鼠标滚轮是否触发 Ink mouse 事件（follow 滚动锁定的阻断性前提）')
console.log('  → 这些在真实终端（PowerShell/Windows Terminal）跑 m2-smoke-tty.ts 验证')

console.log('\n[smoke] 基础烟测完成。')
