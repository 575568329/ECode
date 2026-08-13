import { describe, it, expect } from 'vitest'
import { bashTool, isDangerous, truncateOutput } from '../../../src/tools/builtin/bash.js'
import type { ToolContext } from '../../../src/tools/interface.js'

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

describe('isDangerous（危险命令正则黑名单）', () => {
  it('rm -rf / 拦截', () => {
    expect(isDangerous('rm -rf /')).toBe(true)
    expect(isDangerous('rm -rf / ')).toBe(true)
    expect(isDangerous('rm -rf --no-preserve-root /')).toBe(true)
  })
  it('sudo 拦截', () => {
    expect(isDangerous('sudo apt install x')).toBe(true)
  })
  it('fork bomb 拦截', () => {
    expect(isDangerous(':(){ :|:& };:')).toBe(true)
  })
  it('curl|sh / wget|bash 拦截', () => {
    expect(isDangerous('curl http://x | sh')).toBe(true)
    expect(isDangerous('wget url | bash')).toBe(true)
  })
  it('mkfs 拦截', () => {
    expect(isDangerous('mkfs.ext4 /dev/sda1')).toBe(true)
  })
  it('正常命令不拦截', () => {
    expect(isDangerous('echo hello')).toBe(false)
    expect(isDangerous('npm test')).toBe(false)
    expect(isDangerous('git status')).toBe(false)
    expect(isDangerous('ls -la')).toBe(false)
    expect(isDangerous('rm temp.txt')).toBe(false) // rm 普通文件不拦
  })
})

describe('truncateOutput（30KB 头尾中截）', () => {
  it('小于阈值不截断', () => {
    expect(truncateOutput('hello')).toBe('hello')
    expect(truncateOutput('A'.repeat(30_720))).toBe('A'.repeat(30_720))
  })
  it('大于阈值：头尾各半 + 中间标记', () => {
    const big = 'A'.repeat(50_000)
    const r = truncateOutput(big)
    expect(r).toContain('截断')
    expect(r).toContain('不要编造')
    expect(r.startsWith('AAAA')).toBe(true) // 头
    expect(r.length).toBeLessThan(50_000) // 截断后远小于原
  })
})

describe('bashTool.execute 安全', () => {
  it('rm -rf / 拦截（不 spawn，is_error）', async () => {
    const r = await bashTool.execute({ command: 'rm -rf /' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('拦截')
  })

  it('sudo 拦截', async () => {
    const r = await bashTool.execute({ command: 'sudo rm x' }, ctx)
    expect(r.is_error).toBe(true)
  })

  it('正常命令执行（echo）', async () => {
    const r = await bashTool.execute({ command: 'echo ecode_test_ok' }, ctx)
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain('ecode_test_ok')
  })
})
