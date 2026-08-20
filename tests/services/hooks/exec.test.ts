import { describe, expect, it, afterEach } from 'vitest'
import { runCommandHook, __setHookBlockedForTest } from '../../../src/services/hooks/exec.js'
import type { HookInput, HookSpec } from '../../../src/services/hooks/types.js'

function spec(command: string, timeout_ms?: number): HookSpec {
  return { event: 'PreToolUse', handler: { kind: 'command', command, ...(timeout_ms !== undefined ? { timeout_ms } : {}) } }
}

const input: HookInput = { event: 'PreToolUse', session_id: 's1', tool_name: 'bash', tool_input: { a: 1 } }

describe('runCommandHook（真实 spawn，跨平台 sh/bash）', () => {
  it('exit 0 + stdout JSON → HookOutput（字段级过滤，未知字段剥离）', async () => {
    const out = await runCommandHook(
      spec(`echo '{"continue":false,"reason":"no","junk":"x"}'`),
      input,
    )
    expect(out).toEqual({ continue: false, reason: 'no' })
  })

  it('exit 0 + 非 JSON / 空 stdout → null（纯通知）', async () => {
    expect(await runCommandHook(spec('echo plain-text'), input)).toBeNull()
    expect(await runCommandHook(spec('true'), input)).toBeNull()
  })

  it('stdin 收到事件 JSON（hook 读 stdin 产出协议输出）', async () => {
    const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({additionalContext:'got:'+j.event+':'+j.tool_name}))})"`
    const out = await runCommandHook(spec(cmd), input)
    expect(out).toEqual({ additionalContext: 'got:PreToolUse:bash' })
  })

  it('exit 2 → block + reason 取 stderr 末行', async () => {
    const out = await runCommandHook(spec(`echo 'line1
blocked reason here' >&2; exit 2`), input)
    expect(out).toEqual({ continue: false, reason: 'blocked reason here' })
  })

  it('exit 2 无 stderr → continue:false 无 reason', async () => {
    const out = await runCommandHook(spec('exit 2'), input)
    expect(out).toEqual({ continue: false })
  })

  it('其他退出码 → throw（runner fail-open 兜底）', async () => {
    await expect(runCommandHook(spec(`echo oops >&2; exit 3`), input)).rejects.toThrow('退出码 3')
  })

  it('超时 → kill + throw（handler 级 timeout_ms 生效）', async () => {
    await expect(runCommandHook(spec('sleep 5', 300), input)).rejects.toThrow('超时')
  }, 5_000)

  it('危险命令黑名单 → 拒绝执行（throw，不 spawn）', async () => {
    await expect(runCommandHook(spec('sudo rm -rf /'), input)).rejects.toThrow('危险黑名单')
  })

  it('abort 信号 → 杀进程 + throw', async () => {
    const ctrl = new AbortController()
    const p = runCommandHook(spec('sleep 5'), input, { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 200)
    await expect(p).rejects.toThrow('中断')
  }, 5_000)

  it('非 command 形态 → throw（未实现）', async () => {
    const bad = { event: 'Stop' as const, handler: { kind: 'mcp_tool' as const, server: 's', tool: 't', input: {} } }
    await expect(runCommandHook(bad, input)).rejects.toThrow('未实现')
  })
})

describe('runCommandHook blockedCommands（P1：deny 清单同过，不只在 bash 工具生效）', () => {
  afterEach(() => {
    __setHookBlockedForTest(null)
  })

  it('命中 blockedCommands → throw 拒绝执行（不 spawn）', async () => {
    __setHookBlockedForTest(['npm publish*'])
    await expect(runCommandHook(spec('npm publish --access public'), input)).rejects.toThrow('blockedCommands')
  })

  it('变体绕过同样命中（归一化分词：引号/路径/大小写）', async () => {
    __setHookBlockedForTest(['git push --force*'])
    await expect(runCommandHook(spec('"git" push --force origin main'), input)).rejects.toThrow('blockedCommands')
  })

  it('git push 强推特判：空清单也拦', async () => {
    __setHookBlockedForTest([])
    await expect(runCommandHook(spec('git push -f origin main'), input)).rejects.toThrow('blockedCommands')
  })

  it('未命中 → 正常执行（echo 非 JSON → null）', async () => {
    __setHookBlockedForTest(['npm publish*'])
    expect(await runCommandHook(spec('echo hook-ok'), input)).toBeNull()
  })
})
