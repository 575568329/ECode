/**
 * F-01：CLI 参数校验（TDD 先测后修）。
 * 修复前：`ecode --version` 等静默当 prompt 进 argv 单次模式烧 token。
 * 修复后：-v/--version、-h/--help 提前分流（exit 0，零 LLM）；未知 `-` 开头 token 报错 exit 1；
 * serve 子命令族、--yes/--history、非 `-` 开头位置参数（单次模式）行为不变。
 */
import { describe, it, expect } from 'vitest'
import { parseArgv } from '../../src/cli/args.js'

describe('F-01 parseArgv', () => {
  it('无参 → REPL', () => {
    const { usage: _u, ...rest } = parseArgv([])
    expect(rest).toEqual({ mode: 'repl', input: '', autoYes: false, historySessionId: undefined })
  })

  it('-v / --version → 输出版本 exit 0', () => {
    expect(parseArgv(['-v']).mode).toBe('version')
    expect(parseArgv(['--version']).mode).toBe('version')
  })

  it('-h / --help → usage exit 0', () => {
    expect(parseArgv(['-h']).mode).toBe('help')
    expect(parseArgv(['--help']).mode).toBe('help')
  })

  it('未知 flag → 错误（含用法提示）exit 1', () => {
    const r = parseArgv(['--stats'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') {
      expect(r.message).toContain('--stats')
      expect(r.usage).toContain('ecode')
    }
    expect(parseArgv(['-x']).mode).toBe('error')
  })

  it('serve 子命令族不变', () => {
    expect(parseArgv(['serve']).mode).toBe('serve')
    expect(parseArgv(['serve', 'stop']).mode).toBe('serve')
    expect(parseArgv(['serve', '--port', '3000']).mode).toBe('serve')
  })

  it('位置参数 → 单次模式（保留脚本/管道用法）', () => {
    const r = parseArgv(['你好，帮我看看'])
    expect(r.mode).toBe('repl') // repl 分支承载 argv 单次（input 非空即单次）
    if (r.mode === 'repl') expect(r.input).toBe('你好，帮我看看')
  })

  it('--yes 与位置参数组合', () => {
    const r = parseArgv(['--yes', '跑测试'])
    expect(r.mode).toBe('repl')
    if (r.mode === 'repl') {
      expect(r.autoYes).toBe(true)
      expect(r.input).toBe('跑测试')
    }
  })

  it('--history <id> 解析不变', () => {
    const r = parseArgv(['--history', 'abc'])
    expect(r.mode).toBe('repl')
    if (r.mode === 'repl') expect(r.historySessionId).toBe('abc')
  })

  it('--history 缺参 / 与位置参数互斥 → error', () => {
    expect(parseArgv(['--history']).mode).toBe('error')
    expect(parseArgv(['--history', 'a', '问题']).mode).toBe('error')
  })

  it('已知的非 flag 语义不被误伤：负数等以 - 开头的单字符除外仍报错（只白名单 -v/-h）', () => {
    expect(parseArgv(['-f']).mode).toBe('error')
  })
})
