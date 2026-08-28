import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { OutputViewer, OutputListPage, toolResultSource, taskFileSource, type LineSource, type RecentTool } from '../../src/tui/OutputViewer.js'

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