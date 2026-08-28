import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { InputStream } from '../../src/tui/InputStream.js'
import { extractAtQuery, applyAtCompletion } from '../../src/tui/atsuggest.js'
import { loadInputHistory, appendInputHistory, INPUT_HISTORY_MAX } from '../../src/tui/inputHistory.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 80))

// 临时项目目录（@ 补全候选 + 历史落盘都指向它——不污染仓库自身）
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-uitest-'))
  fs.mkdirSync(path.join(tmp, 'src'))
  fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'x')
  fs.writeFileSync(path.join(tmp, 'readme.md'), 'x')
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'node_modules', 'junk.js'), 'x')
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('extractAtQuery（@ 查询词提取）', () => {
  it('裸 @ 返回空查询', () => {
    expect(extractAtQuery('@', 1)).toEqual({ atIdx: 0, query: '' })
  })
  it('@src 提取 src', () => {
    expect(extractAtQuery('@src', 4)).toEqual({ atIdx: 0, query: 'src' })
  })
  it('email 形态不触发（@ 前非空白）', () => {
    expect(extractAtQuery('a@b.com', 6)).toBeUndefined()
  })
  it('文本后跟 @ 触发（前有空白）', () => {
    expect(extractAtQuery('看下 @src/a', 11)).toEqual({ atIdx: 3, query: 'src/a' })
  })
  it('查询词含空格失效', () => {
    expect(extractAtQuery('@src app', 8)).toBeUndefined()
  })
  it('光标在 @ 之前不触发', () => {
    expect(extractAtQuery('@src', 0)).toBeUndefined()
  })
})

describe('applyAtCompletion', () => {
  it('补全为 @路径 + 尾随空格（文件）', () => {
    expect(applyAtCompletion('看下 @re', 3, { rel: 'readme.md', dir: false })).toBe('看下 @readme.md ')
  })
  it('目录补全加尾 / 续写下一级', () => {
    expect(applyAtCompletion('@sr', 0, { rel: 'src', dir: true })).toBe('@src/')
  })
  it('@ 段之后的右侧文本保留', () => {
    expect(applyAtCompletion('@sr 结尾', 0, { rel: 'src', dir: true })).toBe('@src/ 结尾')
  })
})

/** 逐键写入（批2b-fix 教训：多字符一次 write 的解析行为与真实键盘不同——时序敏感用例逐键发） */
const typeIn = async (stdin: { write(s: string): void }, text: string): Promise<void> => {
  for (const ch of text) {
    stdin.write(ch)
    await flush()
  }
}

describe('InputStream @ 补全（A1 端到端）', () => {
  it('输入 @ 出现候选下拉（cwd 相对路径）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    await typeIn(stdin, '@src')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('@src/')
    expect(f).toContain('@src/app.ts')
    expect(f).not.toContain('node_modules') // 排除
  })

  it('@src → Tab 补全为 @src/（目录优先，尾 / 续写）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    await typeIn(stdin, '@src')
    await flush()
    stdin.write('\t')
    await flush()
    expect(lastFrame() ?? '').toContain('@src/')
  })

  it('@ 下拉 ↑↓ 选择 + Enter 补全', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    await typeIn(stdin, '@re')
    await flush()
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('@readme.md')
  })

  it('Esc 关闭下拉不吞后续输入', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    stdin.write('@')
    await flush()
    stdin.write('\x1b')
    await flush()
    expect(lastFrame() ?? '').not.toContain('↑↓ 选择')
    stdin.write('x') // @ 后继续输入——同锚不重开
    await flush()
    expect(lastFrame() ?? '').toContain('@x')
    expect(lastFrame() ?? '').not.toContain('↑↓ 选择')
  })
})

describe('inputHistory 持久化（A2 存储层）', () => {
  it('追加 + 读回（去重移尾）', () => {
    appendInputHistory(tmp, '第一条')
    appendInputHistory(tmp, '第二条')
    appendInputHistory(tmp, '第一条')
    expect(loadInputHistory(tmp)).toEqual(['第二条', '第一条'])
  })
  it('空串忽略 / 损坏文件返回 []', () => {
    appendInputHistory(tmp, '  ')
    expect(loadInputHistory(tmp)).toEqual([])
    fs.mkdirSync(path.join(tmp, '.ecode'), { recursive: true }) // 损坏文件写入前置目录
    fs.writeFileSync(path.join(tmp, '.ecode', 'input-history.json'), '{oops')
    expect(loadInputHistory(tmp)).toEqual([])
  })
  it('FIFO 上限 500', () => {
    for (let i = 0; i < INPUT_HISTORY_MAX + 10; i++) appendInputHistory(tmp, `h${i}`)
    const h = loadInputHistory(tmp)
    expect(h.length).toBe(INPUT_HISTORY_MAX)
    expect(h[0]).toBe(`h10`)
  })
})

describe('InputStream Ctrl+R 搜索（A2 端到端）', () => {
  it('持久历史跨实例可见 + Ctrl+R 进入搜索态', async () => {
    appendInputHistory(tmp, 'npm run build')
    appendInputHistory(tmp, 'vitest run')
    const { stdin, lastFrame } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    stdin.write('\x12') // Ctrl+R
    await flush()
    expect(lastFrame() ?? '').toContain('搜索:')
    // 输入过滤词
    stdin.write('vit')
    await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('vit')
    expect(f).toContain('1/1')
    // Enter 填入（不发送）
    stdin.write('\r')
    await flush()
    expect(lastFrame() ?? '').toContain('vitest run')
  })

  it('会话内提交 → 落盘可读回（submit 即 append）', async () => {
    const { stdin } = render(
      React.createElement(InputStream, { onSubmit: () => {}, cwd: tmp }),
    )
    await flush()
    stdin.write('hello 提交一条')
    await flush()
    stdin.write('\r')
    await flush()
    expect(loadInputHistory(tmp)).toContain('hello 提交一条')
  })
})
