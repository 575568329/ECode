import {describe, expect, it, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {render, cleanup } from 'ink-testing-library'
import React from 'react'
import { OutputViewer, OutputListPage, toolResultSource, taskFileSource, timelineSource, type LineSource, type RecentTool } from '../../src/tui/OutputViewer.js'
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
    const src = toolResultSource(() => tool, 30)
    expect(src.lines()).toHaveLength(4) // ceil(100/30)
    expect(src.isGrowing()).toBe(false)
    // 补全：换新对象（content 变长）——同 source 即时看到新内容（缓存以内容长度校验失效）
    tool = { ...tool, content: 'y'.repeat(150) }
    expect(src.lines()).toHaveLength(5) // ceil(150/30)
    expect(toolResultSource(() => undefined, 30).lines()).toEqual([]) // 条目被挤出环形缓冲
  })

  it('taskFileSource：文件不存在返回空行（活任务边界）', () => {
    const src = taskFileSource('nonexistent-task', 40)
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
})

describe('timelineSource 增量缓存（四角色审阅 D4/P2 补测）', () => {
  it('未变化命中缓存（同引用）；追加只增不重排', () => {
    let msgs: unknown[] = [{ role: 'user', content: '你好' }]
    let width = 40
    const src = timelineSource(() => msgs, width)
    const first = src.lines()
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('user: 你好')
    expect(src.lines()).toBe(first) // 顶层缓存命中
    msgs = [...msgs, { role: 'assistant', content: [{ type: 'text', text: '回复' }] }]
    const second = src.lines()
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0]) // 历史消息按对象身份缓存不重排
    expect(second).toHaveLength(2)
    // 注：width 是创建期快照（按值入闭包）——resize 不重建属既定口径（面板 width 快照挂账），
    // 同 msgs 重调 lines() 恒命中缓存
    expect(src.lines()).toBe(second)
  })

  it('非对象消息（原始字符串）不进 WeakMap 直格式化（stringify 后为合法 JSON 即原样）', () => {
    const msgs: unknown[] = ['not-json-line']
    const src = timelineSource(() => msgs, 40)
    // 源类型契约=对象消息；stringify('not-json-line') 是合法 JSON 字面量 → parse 成功原样透出
    expect(src.lines()[0]).toBe('"not-json-line"')
  })
})