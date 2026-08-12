import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { readFileTool } from '../../src/tools/builtin/read_file.js'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-rf-'))
const ac = () => new AbortController().signal

describe('read_file', () => {
  it('读存在的文件 → content', async () => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello world')
    const res = await readFileTool.execute({ path: 'a.txt' }, { cwd, signal: ac() })
    expect(res.is_error).toBeFalsy()
    expect(res.content).toBe('hello world')
  })

  it('读不存在 → is_error', async () => {
    const res = await readFileTool.execute({ path: 'nope.txt' }, { cwd, signal: ac() })
    expect(res.is_error).toBe(true)
  })

  it('相对 cwd 解析子目录', async () => {
    fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'sub', 'b.txt'), 'sub content')
    const res = await readFileTool.execute({ path: 'sub/b.txt' }, { cwd, signal: ac() })
    expect(res.content).toBe('sub content')
  })

  it('绝对路径也能读', async () => {
    const abs = path.join(cwd, 'abs.txt')
    fs.writeFileSync(abs, 'abs content')
    const res = await readFileTool.execute({ path: abs }, { cwd, signal: ac() })
    expect(res.content).toBe('abs content')
  })
})
