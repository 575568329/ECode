import {describe, expect, it, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { OutputViewer, OutputListPage, toolResultSource, taskFileSource, timelineSource, mdBlock, formatAgentLine, __setWheelClockForTest, type LineSource, type RecentTool, formatTimelineMessage } from '../../src/tui/OutputViewer.js'
// formatTimelineMessage 见下方增量② describe 前 import 补齐
import { isMouseInput } from '../../src/tui/PanelShell.js'

afterEach(() => cleanup()) // 批量补：逐测卸载，防跨文件遗留挂载叠加掉帧（fix2 第 1 项）

// 隔离真实 ~/.ecode（[[agent-replay-test-safety]]：测试不读真用户目录——子代理 transcript 段落到假 home）
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:os')
  return { ...actual, homedir: () => join(tmpdir(), 'ecode-ov-test-home') }
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// ink-testing ESC/按键 20ms flush（[[ink-testing-escape-flush]]）
const flush = (): Promise<void> => sleep(30)

/** 静态源工厂（固定行） */
const staticSource = (n: number): LineSource => {
  const lines = Array.from({ length: n }, (_, i) => `line-${i}`)
  return { lines: () => lines, isGrowing: () => false }
}

describe('OutputViewer 文本滚动窗（M14-V3）', () => {
  it('初始定位尾部（L 状态行 + 尾部内容可见）', () => {
    const { lastFrame } = render(<OutputViewer title="测试" source={staticSource(100)} onBack={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('line-99')
    expect(frame).not.toContain('line-0')
    expect(frame).toMatch(/L\d+-L\d+ \/ 100/)
  })

  it('g/G 头尾跳转 + ↑ 上滚', async () => {
    const { lastFrame, stdin } = render(<OutputViewer title="t" source={staticSource(100)} onBack={() => {}} />)
    stdin.write('g')
    await flush()
    expect(lastFrame()).toContain('line-0')
    stdin.write('G')
    await flush()
    expect(lastFrame()).toContain('line-99')
    stdin.write('\u001b[A') // ↑
    await flush()
    expect(lastFrame()).toContain('line-98')
  })

  it('搜索：/ 进入输入态，Enter 确认跳匹配，n 下一个', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => (i % 10 === 5 ? `HIT-${i}` : `x-${i}`))
    const source: LineSource = { lines: () => lines, isGrowing: () => false }
    const { lastFrame, stdin } = render(<OutputViewer title="t" source={source} onBack={() => {}} />)
    stdin.write('g') // 回顶——底部顶格时 n 无下跳空间
    await flush()
    stdin.write('/')
    await flush()
    expect(lastFrame()).toContain('/')
    stdin.write('HIT')
    await flush()
    stdin.write('\r')
    await flush()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('匹配 10')
    expect(frame).toContain('HIT-')
    const before = Number(frame.match(/L(\d+)-/)?.[1])
    stdin.write('n')
    await flush()
    const after = Number(lastFrame()?.match(/L(\d+)-/)?.[1])
    expect(after).toBeGreaterThan(before) // 严格越过当前 offset（next 语义）
  })

  it('Esc 返回（onBack 回调）', async () => {
    let back = 0
    const { stdin } = render(<OutputViewer title="t" source={staticSource(5)} onBack={() => { back += 1 }} />)
    stdin.write('\u001b')
    await flush()
    expect(back).toBe(1)
  })

  it('follow：增长通知自动滚到底，手动上滚断开', async () => {
    let notify: (() => void) | null = null
    let lines = Array.from({ length: 20 }, (_, i) => `l-${i}`)
    const source: LineSource = {
      lines: () => lines,
      isGrowing: () => true,
      subscribe: (cb) => {
        notify = cb
        return () => {}
      },
    }
    const { lastFrame, stdin } = render(<OutputViewer title="t" source={source} onBack={() => {}} />)
    await flush()
    // 增长 30 行 → 自动滚到底
    lines = [...lines, ...Array.from({ length: 30 }, (_, i) => `new-${i}`)]
    notify?.()
    await flush()
    expect(lastFrame()).toContain('new-29')
    // 手动上滚 → follow 断开；再增长不再跟随
    stdin.write('\u001b[A')
    await flush()
    lines = [...lines, ...Array.from({ length: 20 }, (_, i) => `tail-${i}`)]
    notify?.()
    await flush()
    expect(lastFrame()).not.toContain('tail-19')
    expect(lastFrame()).toContain('[F]跟随(off)')
  })
})

describe('LineSource 适配器（M14-V3）', () => {
  it('toolResultSource：getter 化（审阅 P1-4——补全后新对象即时可见）+ wrap 物理行 + 非增长', () => {
    let tool: RecentTool | undefined = { itemId: 'i1', name: 'bash', content: 'x'.repeat(100), isError: false, at: 0 }
    const src = toolResultSource(() => tool, () => 30)
    expect(src.lines()).toHaveLength(4) // ceil(100/30)
    expect(src.isGrowing()).toBe(false)
    // 补全：换新对象（content 变长）——同 source 即时看到新内容（缓存以内容长度校验失效）
    tool = { ...tool, content: 'y'.repeat(150) }
    expect(src.lines()).toHaveLength(5) // ceil(150/30)
    expect(toolResultSource(() => undefined, () => 30).lines()).toEqual([]) // 条目被挤出环形缓冲
  })

  it('taskFileSource：文件不存在返回空行（活任务边界）', () => {
    const src = taskFileSource('nonexistent-task', () => 40)
    expect(src.lines()).toEqual([])
    expect(src.isGrowing()).toBe(false)
  })
})

describe('OutputListPage（M14-V3）', () => {
  it('三段列表：任务/工具/子代理（子代理段读真实 ~/.ecode/agents——无则跳过）', () => {
    const tools: RecentTool[] = [
      { itemId: 'i1', name: 'bash', content: 'hello\nworld', isError: false, at: 0 },
      { itemId: 'i2', name: 'edit_file', content: 'diff --git a', isError: true, at: 0 },
    ]
    const { lastFrame } = render(<OutputListPage recentTools={tools} onOpen={() => {}} onExit={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('最近工具调用')
    expect(frame).toContain('bash')
    expect(frame).toContain('edit_file')
    expect(frame).toContain('diff --git')
    expect(frame).toContain('输出查看')
  })

  it('全空：空态提示', () => {
    const { lastFrame } = render(<OutputListPage recentTools={[]} onOpen={() => {}} onExit={() => {}} />)
    expect(lastFrame()).toContain('暂无可查看的输出')
  })
})
// —— F-26：/output 子代理列表上下文 ——
describe('F-26：listSubagentTranscripts 摘要（裸 id → 时间+首行摘要）', () => {
  it('读首条 user 文本做摘要 + 按 mtime 新→旧 + maxShow 截断', async () => {
    const home = join(tmpdir(), 'ecode-ov-test-home')
    const dir = join(home, '.ecode', 'agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a-old.jsonl'), JSON.stringify({ role: 'user', content: [{ type: 'text', text: '旧任务\n细节' }] }) + '\n', 'utf8')
    writeFileSync(join(dir, 'a-new.jsonl'), JSON.stringify({ role: 'user', content: '字符串 content 任务' }) + '\n', 'utf8')
    const { listSubagentTranscripts } = await import('../../src/tui/OutputViewer.js')
    const list = listSubagentTranscripts(10)
    const ids = list.map((a) => a.id)
    expect(ids).toContain('a-old')
    expect(ids).toContain('a-new')
    expect(list.find((a) => a.id === 'a-old')?.summary).toBe('旧任务')
    expect(list.find((a) => a.id === 'a-new')?.summary).toBe('字符串 content 任务')
    expect(listSubagentTranscripts(1).length).toBe(1)
    // 清场：防污染同文件其他用例（OutputListPage 共享同一假 home 的模块级 homedir mock）
    rmSync(dir, { recursive: true, force: true })
  })
})


describe('F-51/F-48b：滚轮与鼠标输入（四角色审阅 D4 补测）', () => {
  it('isMouseInput 全形态：滚轮/按键/motion/释放识别，普通字符与残缺形态排除', () => {
    expect(isMouseInput('[<64;10;10M')).toBe(true) // 上滚
    expect(isMouseInput('[<65;1;1M')).toBe(true) // 下滚
    expect(isMouseInput('[<0;5;5M')).toBe(true) // 左键按下
    expect(isMouseInput('[<2;5;5m')).toBe(true) // 释放（小写 m）
    expect(isMouseInput('[<32;5;5M')).toBe(true) // motion
    expect(isMouseInput('a')).toBe(false)
    expect(isMouseInput('[<64M')).toBe(false) // 缺坐标（正则残缺形态的回归锁）
    expect(isMouseInput('')).toBe(false)
  })

  it('滚轮下滚/上滚 → offset 行级移动，序列不进搜索词', async () => {
    const { lastFrame, stdin } = render(<OutputViewer title="t" source={staticSource(100)} onBack={() => {}} />)
    stdin.write('g')
    await flush()
    expect(lastFrame()).toContain('line-0')
    stdin.write('\x1b[<65;1;1M')
    await flush()
    expect(lastFrame()).toContain('line-1')
    expect(lastFrame()).not.toContain('line-0\n')
    expect(lastFrame()).not.toContain('65;1;1') // 未被当可打印字符吃进搜索
    stdin.write('\x1b[<64;1;1M')
    await flush()
    expect(lastFrame()).toContain('line-0')
  })

  it('ECODE_SCROLL_SPEED 旋钮：基础倍率放大单事件步进', async () => {
    const prev = process.env.ECODE_SCROLL_SPEED
    process.env.ECODE_SCROLL_SPEED = '5'
    try {
      const { lastFrame, stdin } = render(<OutputViewer title="t" source={staticSource(100)} onBack={() => {}} />)
      stdin.write('g')
      await flush()
      stdin.write('\x1b[<65;1;1M')
      await flush()
      expect(lastFrame()).toContain('line-5')
    } finally {
      if (prev === undefined) delete process.env.ECODE_SCROLL_SPEED
      else process.env.ECODE_SCROLL_SPEED = prev
    }
  })

  it('滚轮加速（项 3 假时钟）：200ms 窗内连续滚动倍率线性递增（7 连滚 10 行而非 7 行）', async () => {
    let t = 1_000
    __setWheelClockForTest(() => t)
    try {
      const { lastFrame, stdin } = render(<OutputViewer title="t" source={staticSource(100)} onBack={() => {}} />)
      stdin.write('g')
      await flush()
      // 倍率 floor 序列：1,1,1,1,2,2,2 → 累计 10 行（无加速为 7）
      for (let i = 0; i < 7; i++) {
        t += 100 // 窗内（<200ms）
        stdin.write('\x1b[<65;1;1M')
        await flush()
      }
      expect(lastFrame()).toContain('line-10')
    } finally {
      __setWheelClockForTest(() => Date.now())
    }
  })

  it('停手超窗重置倍率（项 3）：加速后再滚一步回落基础步进', async () => {
    let t = 1_000
    __setWheelClockForTest(() => t)
    try {
      const { lastFrame, stdin } = render(<OutputViewer title="t" source={staticSource(100)} onBack={() => {}} />)
      stdin.write('g')
      await flush()
      for (let i = 0; i < 7; i++) {
        t += 100
        stdin.write('\x1b[<65;1;1M')
        await flush()
      }
      t += 1000 // 停手 >200ms：倍率重置
      stdin.write('\x1b[<65;1;1M')
      await flush()
      expect(lastFrame()).toContain('line-11')
    } finally {
      __setWheelClockForTest(() => Date.now())
    }
  })
})

describe('timelineSource（输入体验批：与主对话流同构格式化 + 增量缓存）', () => {
  it('用户消息：❯ 前缀 + 全文不截断 + 上下空行边距', () => {
    const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}段粘贴内容`).join('，')
    const msgs: unknown[] = [{ role: 'user', content: [{ type: 'text', text: long }] }]
    const src = timelineSource(() => msgs, () => 60)
    const lines = src.lines()
    expect(lines[0]).toBe('') // 上边距
    expect(lines[1]).toContain('❯')
    expect(lines.at(-1)).toBe('') // 下边距
    // 全文不截断：剥 SGR/空白/换行后全文连续可比对（wrap 断行会拆 CJK 词，不能逐段子串断言）
    const bare = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/[\s]/g, '')
    expect(bare).toContain(long)
    expect(bare).not.toContain('已截断')
  })

  it('增量缓存：追加只格式化新消息（历史行按对象身份原样保留）', () => {
    let msgs: unknown[] = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    const src = timelineSource(() => msgs, () => 40)
    const first = src.lines()
    const userLines = first.filter((l) => l.includes('你好'))
    expect(userLines.length).toBeGreaterThanOrEqual(1)
    msgs = [...msgs, { role: 'assistant', content: [{ type: 'text', text: '回复' }] }]
    const second = src.lines()
    expect(second.slice(0, first.length)).toEqual(first) // 历史前缀不重排
    expect(second.join('\n')).toContain('回复')
  })

  it('CONTINUE_PROMPT 合成指令不渲染；tool_result 出摘要行', () => {
    const msgs: unknown[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '命令输出 42 行' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '输出已达 max_tokens 上限被截断。请从中断处直接继续输出：不要道歉、不要复述已写内容，必要时把剩余工作拆成更小的步骤分批输出。' },
        ],
      },
    ]
    const all = timelineSource(() => msgs, () => 60).lines().join('\n')
    expect(all).toContain('└')
    expect(all).toContain('命令输出 42 行')
    expect(all).not.toContain('不要道歉')
  })

  it('boundary/rewind 标记行渲染语义提示（compact_boundary 字段）', () => {
    const msgs: unknown[] = [
      { compact_boundary: true, tailStartIndex: 7 },
      { rewind: true, seq: 12 },
    ]
    const all = timelineSource(() => msgs, () => 60).lines().join('\n')
    expect(all).toContain('已压缩对话')
    expect(all).toContain('7 条已摘要')
    expect(all).toContain('⇺ 已回退')
  })

  it('assistant 文本走 ◆ + mdBlock；tool_use 出 ▸ 单行', () => {
    const msgs: unknown[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '结论如下' },
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        ],
      },
    ]
    const all = timelineSource(() => msgs, () => 60).lines().join('\n')
    expect(all).toContain('◆ 结论如下')
    expect(all).toMatch(/▢.*bash/) // 增量②形态：图标+digest（SGR 色码在图标与名间）
  })

  it('非对象消息（原始字符串）不进 WeakMap 原样透出', () => {
    const msgs: unknown[] = ['not-json-line']
    const src = timelineSource(() => msgs, () => 40)
    expect(src.lines()[0]).toBe('not-json-line')
  })
})

describe('mdBlock 块级 markdown（项 9，方案 A 二期）', () => {
  const ESC = String.fromCharCode(27)
  it('围栏代码块：围栏行与内容行 dim+缩进', () => {
    const lines = mdBlock('前文\n```js\nconst a = 1\n```\n后文')
    expect(lines[0]).toBe('前文')
    expect(lines[1]).toBe(ESC + '[2m```js' + ESC + '[22m')
    expect(lines[2]).toBe('  ' + ESC + '[2mconst a = 1' + ESC + '[22m')
    expect(lines[3]).toBe(ESC + '[2m```' + ESC + '[22m')
    expect(lines[4]).toBe('后文')
  })

  it('标题加粗/引用 dim+│ 前缀/无序列表 • 符号/行内粗体保留', () => {
    const lines = mdBlock('## 我的标题\n> 引用一句\n- 第一项\n  - 嵌套项\n普通 **加粗** 行')
    expect(lines[0]).toBe(ESC + '[1m我的标题' + ESC + '[22m')
    expect(lines[1]).toBe(ESC + '[2m│ 引用一句' + ESC + '[22m')
    expect(lines[2]).toContain('• 第一项')
    expect(lines[3]).toBe('  • 嵌套项')
    expect(lines[4]).toContain(ESC + '[1m加粗' + ESC + '[22m')
  })

  it('超 maxLines 行截断并给计数提示（内容 maxLines 行+提示 1 行）', () => {
    const text = Array.from({ length: 80 }, (_, i) => `第${i}行`).join('\n')
    const lines = mdBlock(text, 60)
    expect(lines).toHaveLength(61)
    expect(lines[60]).toContain('还有 20 行')
  })

  it('formatAgentLine assistant text 走块级（◆ 首行+续行缩进——对话栅格同款）', () => {
    const line = JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '总结如下：\n```\n代码内容\n```' }] })
    const out = formatAgentLine(line, 80)
    expect(out[0]).toBe('◆ 总结如下：')
    expect(out[1]).toBe('  ' + ESC + '[2m```' + ESC + '[22m')
    expect(out[2]).toBe('    ' + ESC + '[2m代码内容' + ESC + '[22m') // mdBlock 缩进 2+formatAgentLine 续行 2
  })
})


// —— 活动流增量②（G+）：面板工具行 digest/✓✗/结果配对 ——
describe('formatTimelineMessage 工具行配对（增量②）', () => {
  const width = 100
  it('tool_use 带 digest + toolIcon；无结果无尾符', () => {
    const lines = formatTimelineMessage(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'foo', path: 'src' } }] },
      width,
    )
    const row = lines.find((l) => l.includes('grep')) ?? ''
    expect(row).toContain('⌕') // D11 按类型图标
    expect(row).toContain('src') // makeToolDigest 单源摘要（PATH_FIELDS 优先 path>pattern）
    expect(row).not.toContain('✓')
  })

  it('配对 tool_result → ✓ + 结果 preview 行', () => {
    const results = new Map([['t1', { isError: false, content: 'src/a.ts:3:foo' + String.fromCharCode(10) + 'src/b.ts:7:foo' }]])
    const lines = formatTimelineMessage(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'foo' } }] },
      width,
      results,
    )
    expect(lines.some((l) => l.includes('✓'))).toBe(true)
    expect(lines.some((l) => l.includes('src/a.ts:3:foo'))).toBe(true)
  })

  it('is_error 结果 → ✗', () => {
    const results = new Map([['t2', { isError: true, content: '工具失败' }]])
    const lines = formatTimelineMessage(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: { command: 'npm test' } }] },
      width,
      results,
    )
    expect(lines.some((l) => l.includes('✗'))).toBe(true)
  })
})
