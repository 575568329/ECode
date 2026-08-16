import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileTool } from '../../../src/tools/builtin/write_file.js'
import { editFileTool } from '../../../src/tools/builtin/edit_file.js'
import type { ToolContext } from '../../../src/tools/interface.js'
import { makeSandbox } from '../../../src/services/sandbox.js'

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

// —— M9-P1：写前快照回调（onBeforeWrite）——副作用工具 execute 开头调用（loop 层确认已通过）

describe('onBeforeWrite（M9-P1 checkpoint 触发）', () => {
  it('write_file：执行前以绝对路径调用（先于写入）', async () => {
    const calls: Array<[string[], string]> = []
    const ctx2: ToolContext = { ...ctx, onBeforeWrite: async (paths, tool) => { calls.push([paths, tool]) } }
    await writeFileTool.execute({ path: 'a.txt', content: 'x' }, ctx2)
    expect(calls).toEqual([[ [join(tmpDir, 'a.txt')], 'write_file' ]])
    // 覆盖场景：文件已存在也会先快照再写
    const calls2: Array<[string[], string]> = []
    await writeFileTool.execute({ path: 'a.txt', content: 'y' }, { ...ctx, onBeforeWrite: async (p, t) => { calls2.push([p, t]) } })
    expect(calls2).toHaveLength(1)
  })

  it('edit_file：执行前以绝对路径调用', async () => {
    writeFileSync(join(tmpDir, 'e.ts'), 'old')
    const calls: Array<[string[], string]> = []
    await editFileTool.execute(
      { path: 'e.ts', oldString: 'old', newString: 'new' },
      { ...ctx, onBeforeWrite: async (paths, tool) => { calls.push([paths, tool]) } },
    )
    expect(calls).toEqual([[ [join(tmpDir, 'e.ts')], 'edit_file' ]])
  })

  it('read-only 档：write/edit 被拒（is_error + 档位文案）——M9-P4 沙箱前置校验', async () => {
    const ro = { ...ctx, sandbox: makeSandbox('read-only', tmpDir) }
    const w = await writeFileTool.execute({ path: 'ro.txt', content: 'x' }, ro)
    expect(w.is_error).toBe(true)
    expect(w.content).toContain('read-only')
    writeFileSync(join(tmpDir, 'e.ts'), 'old')
    const e = await editFileTool.execute({ path: 'e.ts', oldString: 'old', newString: 'new' }, ro)
    expect(e.is_error).toBe(true)
    expect(e.content).toContain('read-only')
    expect(existsSync(join(tmpDir, 'ro.txt'))).toBe(false) // 未写入
  })

  it('workspace-write 档：cwd 内放行 / 越界拒绝（resolve 后比较，拦 .. 逃逸）', async () => {
    const ww = { ...ctx, sandbox: makeSandbox('workspace-write', tmpDir) }
    const ok = await writeFileTool.execute({ path: 'in.txt', content: 'x' }, ww)
    expect(ok.is_error).toBeFalsy()
    const outside = join(tmpDir, '..', `esc-${Date.now()}.ts`)
    const denied = await writeFileTool.execute({ path: outside, content: 'x' }, ww)
    expect(denied.is_error).toBe(true)
    expect(denied.content).toContain('workspace-write')
    rmSync(join(tmpDir, 'in.txt'), { force: true })
  })

  it('回调抛错不阻断写入（快照失败是安全网问题，不该挡主流程）', async () => {
    const r = await writeFileTool.execute(
      { path: 'b.txt', content: 'z' },
      { ...ctx, onBeforeWrite: async () => { throw new Error('snapshot io error') } },
    )
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(join(tmpDir, 'b.txt'), 'utf8')).toBe('z')
  })
})
