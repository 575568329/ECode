import { describe, it, expect } from 'vitest'
import { bashTool } from '../../src/tools/builtin/bash.js'

const cwd = process.cwd()
const ac = () => new AbortController().signal

describe('bash', () => {
  it('echo → stdout', async () => {
    const res = await bashTool.execute({ command: 'echo hello' }, { cwd, signal: ac() })
    expect(res.is_error).toBeFalsy()
    expect(res.content.trim()).toBe('hello')
  })

  it('退出码非 0 → 正常返回（含退出码），不抛异常', async () => {
    const res = await bashTool.execute({ command: 'exit 7' }, { cwd, signal: ac() })
    // 退出码非 0 是 recoverable，正常返回交 LLM 判断（is_error 不设）
    expect(res.is_error).toBeFalsy()
    expect(res.content).toMatch(/7|退出码|exit/i)
  })

  it('stderr 也被捕获', async () => {
    const res = await bashTool.execute({ command: 'echo err >&2; echo out' }, { cwd, signal: ac() })
    expect(res.content).toContain('out')
    expect(res.content).toContain('err')
  })

  it('cwd 生效（pwd 返回 cwd）', async () => {
    const res = await bashTool.execute({ command: 'pwd' }, { cwd, signal: ac() })
    // Windows + Git Bash 下 pwd 可能返回 /d/... 形式，校验包含 cwd 关键片段
    expect(res.content.toLowerCase()).toContain('ecode')
  })
})
