import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadEcodeIgnore } from '../../src/services/ignore.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ecode-ignore-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadEcodeIgnore', () => {
  it('默认忽略 node_modules / .git / .env* / dist / build', () => {
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.ignores('node_modules/pkg/index.js')).toBe(true)
    expect(ig.ignores('.git/config')).toBe(true)
    expect(ig.ignores('.env')).toBe(true)
    expect(ig.ignores('.env.local')).toBe(true)
    expect(ig.ignores('dist/bundle.js')).toBe(true)
    expect(ig.ignores('build/out.js')).toBe(true)
  })

  it('不忽略普通源文件', () => {
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.ignores('src/index.ts')).toBe(false)
    expect(ig.ignores('package.json')).toBe(false)
    expect(ig.ignores('README.md')).toBe(false)
  })

  it('合并 cwd/.ecodeignore（自定义规则叠加默认）', () => {
    writeFileSync(join(tmpDir, '.ecodeignore'), '*.test.ts\ncoverage/\n')
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.ignores('foo.test.ts')).toBe(true)
    expect(ig.ignores('coverage/lcov.info')).toBe(true)
    // 默认规则仍在
    expect(ig.ignores('node_modules/x')).toBe(true)
  })

  it('.ecodeignore 注释行和空行被忽略', () => {
    writeFileSync(join(tmpDir, '.ecodeignore'), '# 这是注释\n\n*.log\n')
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.ignores('app.log')).toBe(true)
    // 注释行不当模式
    expect(ig.ignores('这是注释')).toBe(false)
  })

  it('patterns 含默认 + 自定义（给 fast-glob ignore 选项）', () => {
    writeFileSync(join(tmpDir, '.ecodeignore'), '*.test.ts\n')
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.patterns).toContain('node_modules/')
    expect(ig.patterns).toContain('*.test.ts')
  })

  it('无 .ecodeignore 时只有默认规则', () => {
    const ig = loadEcodeIgnore(tmpDir)
    expect(ig.patterns).toEqual(['node_modules/', '.git/', '.env*', 'dist/', 'build/'])
  })
})
