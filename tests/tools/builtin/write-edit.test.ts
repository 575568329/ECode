import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileTool } from '../../../src/tools/builtin/write_file.js'
import { editFileTool } from '../../../src/tools/builtin/edit_file.js'
import type { ToolContext } from '../../../src/tools/interface.js'

let tmpDir: string
let ctx: ToolContext

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ecode-write-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal }
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeFileTool', () => {
  it('写新文件', async () => {
    const r = await writeFileTool.execute({ path: 'a.txt', content: 'hello\nworld' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(join(tmpDir, 'a.txt'), 'utf8')).toBe('hello\nworld')
  })

  it('覆盖已有文件', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'old')
    await writeFileTool.execute({ path: 'a.txt', content: 'new' }, ctx)
    expect(readFileSync(join(tmpDir, 'a.txt'), 'utf8')).toBe('new')
  })
})

describe('editFileTool', () => {
  it('替换唯一匹配', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = old\nconst y = 2\n')
    const r = await editFileTool.execute(
      { path: 'a.ts', oldString: 'const x = old', newString: 'const x = new' },
      ctx,
    )
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(join(tmpDir, 'a.ts'), 'utf8')).toBe('const x = new\nconst y = 2\n')
  })

  it('oldString 未找到 → is_error', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1\n')
    const r = await editFileTool.execute(
      { path: 'a.ts', oldString: 'zzz', newString: 'yyy' },
      ctx,
    )
    expect(r.is_error).toBe(true)
  })

  it('多处匹配（非 replaceAll）→ is_error', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'foo\nfoo\n')
    const r = await editFileTool.execute(
      { path: 'a.ts', oldString: 'foo', newString: 'bar' },
      ctx,
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('2 处')
  })

  it('replaceAll=true 替换所有', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'foo\nfoo\n')
    await editFileTool.execute(
      { path: 'a.ts', oldString: 'foo', newString: 'bar', replaceAll: true },
      ctx,
    )
    expect(readFileSync(join(tmpDir, 'a.ts'), 'utf8')).toBe('bar\nbar\n')
  })

  it('oldString 为空 → is_error（P2#7）', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'x')
    const r = await editFileTool.execute(
      { path: 'a.ts', oldString: '', newString: 'y' },
      ctx,
    )
    expect(r.is_error).toBe(true)
  })

  it('CRLF 归一化（文件 \\r\\n，oldString 给 \\n，P1#5）', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = old\r\nconst y = 2\r\n')
    const r = await editFileTool.execute(
      { path: 'a.ts', oldString: 'const x = old', newString: 'const x = new' },
      ctx,
    )
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(join(tmpDir, 'a.ts'), 'utf8')).toBe('const x = new\r\nconst y = 2\r\n')
  })
})
