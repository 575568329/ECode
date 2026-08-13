import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lsTool } from '../../../src/tools/builtin/ls.js'
import { globTool } from '../../../src/tools/builtin/glob.js'
import { grepTool } from '../../../src/tools/builtin/grep.js'
import type { ToolContext } from '../../../src/tools/interface.js'

let tmpDir: string
let ctx: ToolContext

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ecode-tools-'))
  writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1\nconst y = 2\n')
  writeFileSync(join(tmpDir, 'b.ts'), 'const x = 3\n')
  writeFileSync(join(tmpDir, 'readme.md'), '# Hello\n')
  mkdirSync(join(tmpDir, 'sub'))
  writeFileSync(join(tmpDir, 'sub', 'c.ts'), 'const z = 1\n')
  ctx = { cwd: tmpDir, signal: new AbortController().signal }
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('lsTool', () => {
  it('列当前层文件 + 目录', async () => {
    const r = await lsTool.execute({ path: '.' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('a.ts')
    expect(r.content).toContain('[file]')
    expect(r.content).toContain('[dir]') // sub 目录
  })

  it('depth=2 递归子目录', async () => {
    const r = await lsTool.execute({ path: '.', depth: 2 }, ctx)
    expect(r.content).toContain('sub/c.ts')
  })

  it('不存在的路径 → is_error', async () => {
    const r = await lsTool.execute({ path: 'nope' }, ctx)
    expect(r.is_error).toBe(true)
  })
})

describe('globTool', () => {
  it('匹配 *.ts（当前层）', async () => {
    const r = await globTool.execute({ pattern: '*.ts' }, ctx)
    expect(r.content).toContain('a.ts')
    expect(r.content).toContain('b.ts')
    expect(r.content).not.toContain('readme.md')
  })

  it('递归 **/*.ts', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx)
    expect(r.content).toContain('a.ts')
    expect(r.content).toContain('sub/c.ts')
  })

  it('无匹配', async () => {
    const r = await globTool.execute({ pattern: '*.xyz' }, ctx)
    expect(r.content).toBe('(无匹配)')
  })

  it('caseSensitiveMatch：*.TS 不匹配 .ts（D7）', async () => {
    const r = await globTool.execute({ pattern: '*.TS' }, ctx)
    expect(r.content).toBe('(无匹配)')
  })
})

describe('grepTool', () => {
  it('搜 const x（跨文件）', async () => {
    const r = await grepTool.execute({ pattern: 'const x' }, ctx)
    expect(r.content).toContain('a.ts:1:')
    expect(r.content).toContain('b.ts:1:')
  })

  it('限定 glob *.md', async () => {
    const r = await grepTool.execute({ pattern: 'Hello', glob: '*.md' }, ctx)
    expect(r.content).toContain('readme.md')
    expect(r.content).not.toContain('a.ts')
  })

  it('无匹配', async () => {
    const r = await grepTool.execute({ pattern: 'zzznotexist' }, ctx)
    expect(r.content).toBe('(无匹配)')
  })

  it('无效正则 → is_error', async () => {
    const r = await grepTool.execute({ pattern: '(' }, ctx)
    expect(r.is_error).toBe(true)
  })

  it('path 是文件 → 只搜该文件（不报 ENOTDIR）', async () => {
    const r = await grepTool.execute({ pattern: 'const x', path: 'a.ts' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('a.ts:1:')
  })
})
