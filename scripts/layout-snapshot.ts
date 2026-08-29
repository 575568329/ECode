/**
 * 排版批② 验收留档：ink-testing 渲染固定样例消息的「改动后」帧。
 * 用法：npx tsx scripts/layout-snapshot.ts > docs/解析/排版批2-帧快照-后.md 的代码块内容
 * 与改动前快照（git stash 后同脚本）人工对比留档。
 */
import { render } from 'ink-testing-library'
import React from 'react'
import { Markdown } from '../src/tui/Markdown.js'
import { ToolGroupView } from '../src/tui/ToolGroupView.js'
import { Conversation } from '../src/tui/Conversation.js'
import { createActive, type CommittedItem } from '../src/tui/types.js'

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}

const md = [
  '# 标题一',
  '',
  '这是**加粗**与 `code` 的段落，后接列表：',
  '',
  '- 项一',
  '- 项二',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '> 引用一句话',
].join('\n')

const tool = {
  name: 'read_file',
  use: { type: 'tool_use' as const, id: 't1', name: 'read_file', input: { path: 'a.ts' } },
  result: { type: 'tool_result' as const, tool_use_id: 't1', content: '第一行输出\n第二行输出很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长\n第三行', is_error: false },
  status: 'done' as const,
}

console.log('===== ① Markdown 混合样例 =====')
console.log(stripAnsi(render(React.createElement(Markdown, { text: md })).lastFrame() ?? ''))

console.log('\n===== ② 工具组（折叠 preview / 悬挂缩进 ⎿）=====')
console.log(stripAnsi(render(React.createElement(ToolGroupView, { tools: [tool] })).lastFrame() ?? ''))

console.log('\n===== ③ 工具组展开（输出全文在内容列）=====')
console.log(stripAnsi(render(React.createElement(ToolGroupView, { tools: [tool], expanded: true })).lastFrame() ?? ''))

// F-43：edit_file 副作用工具——diff 全展开（done=true）在单 ⎿ 内容列
const editTool = {
  name: 'edit_file',
  use: { type: 'tool_use' as const, id: 't2', name: 'edit_file', input: { path: 'b.ts' } },
  result: {
    type: 'tool_result' as const,
    tool_use_id: 't2',
    content: '已更新 b.ts（1 处）\n\n--- b.ts\n+++ b.ts\n@@ -1,3 +1,4 @@\n const a = 1\n-const b = 2\n+const b = 3 // 改动行\n+const c = 4\n const d = 5',
    is_error: false,
  },
  status: 'done' as const,
}
console.log('\n===== ③b edit_file diff 全展开（F-43 单 ⎿ 内容列）=====')
console.log(stripAnsi(render(React.createElement(ToolGroupView, { tools: [editTool], done: true })).lastFrame() ?? ''))

const committed: CommittedItem[] = [
  { kind: 'user', id: 'u1', text: '用户的问题' },
  { kind: 'assistant-text', id: 'a1', text: '助手回答段落一。\n\n段落二。' },
  { kind: 'tool-group', id: 'g1', calls: [{ use: tool.use, result: tool.result }] },
]
console.log('\n===== ④ Conversation Static 组合（块间节奏）=====')
console.log(stripAnsi(render(React.createElement(Conversation, { committed, active: createActive() })).lastFrame() ?? ''))
