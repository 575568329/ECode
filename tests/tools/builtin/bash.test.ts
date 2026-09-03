import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { bashTool, isDangerous, truncateOutput, foldNodeWarnings } from '../../../src/tools/builtin/bash.js'
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

describe('truncateOutput（50KB 头尾中截；F-39 对标 CC 50K chars）', () => {
  it('小于阈值不截断（缺省阈值=50KB）', () => {
    expect(truncateOutput('hello')).toBe('hello')
    expect(truncateOutput('A'.repeat(50_000))).toBe('A'.repeat(50_000))
  })
  it('大于阈值：头尾各半 + 中间标记', () => {
    const big = 'A'.repeat(80_000)
    const r = truncateOutput(big)
    expect(r).toContain('截断')
    expect(r).toContain('不要编造')
    expect(r.startsWith('AAAA')).toBe(true) // 头
    expect(r.length).toBeLessThan(80_000) // 截断后远小于原
  })
  it('limit 显式传入接通 config（F-39：此前 30_720 硬编码悬空）', () => {
    const r = truncateOutput('A'.repeat(100), 64)
    expect(r).toContain('已截断')
    expect(r.startsWith('AAAA')).toBe(true)
    expect(r.length).toBeLessThan(200)
  })
  it('savedPath 落盘路径入中截标记（CC persist-to-disk：完整输出可 read_file 回看）', () => {
    const r = truncateOutput('A'.repeat(80_000), 50_000, '/tmp/x/outputs/t1.log')
    expect(r).toContain('完整输出已保存: /tmp/x/outputs/t1.log')
    expect(r).toContain('read_file 查看')
  })
})

describe('foldNodeWarnings（F-22 Node 内部警告折叠）', () => {
  it('MaxListenersExceededWarning 折叠为一行提示，不直打全文', () => {
    const out = [
      '(node:1234) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 message listeners added to [EventEmitter]. Use emitter.setMaxListeners() to increase limit',
      'normal output line',
    ].join('\n')
    const r = foldNodeWarnings(out)
    expect(r).toContain('已折叠')
    expect(r).toContain('MaxListenersExceededWarning')
    expect(r).not.toContain('Possible EventEmitter memory leak') // 全文不出现
    expect(r).toContain('normal output line') // 正常输出保留
  })
  it('纯警告输出 → 只剩折叠提示一行', () => {
    const r = foldNodeWarnings('(node:1) DeprecationWarning: x is deprecated')
    expect(r.trim()).toBe('〔Node 内部警告已折叠：DeprecationWarning——非命令输出，可忽略〕')
  })
  it('无警告输出原样返回', () => {
    expect(foldNodeWarnings('hello\nworld')).toBe('hello\nworld')
  })
  it('多条同类警告去重', () => {
    const out = '(node:1) MaxListenersExceededWarning: a\nout\n(node:2) MaxListenersExceededWarning: b'
    const r = foldNodeWarnings(out)
    expect(r.match(/MaxListenersExceededWarning/g)).toHaveLength(1)
  })
  it('F-22 截断边界（审阅 P1-缺口5）：bash 输出 >30KB 先 truncate 后 fold，警告行被切半仍不泄漏残行', () => {
    // 构造：长前缀（把 30KB 边界推进警告行中间）+ 完整警告行 + 尾缀——truncate 头尾各半，
    // 警告行总长 >30KB 的中段被切走后残留半条 "(node:123) DeprecationWar" 残行。
    // 锁定行为：fold 的 tag 仍提取自完整匹配段；残行无 " Warning:" 结尾不再匹配正则，
    // 会以原样残留在输出（截断本身即丢弃语义）。本用例确保完整警告行位于尾半窗时的行为：
    // 头部被截 + 尾部警告行完整 → 折叠 tag 出现且残头不出现
    const prefix = 'A'.repeat(31_000)
    const warn = '(node:123) DeprecationWarning: x is deprecated'
    const out = `${prefix}\n${warn}\ntail`
    const r = foldNodeWarnings(truncateOutput(out))
    expect(r).toContain('已折叠')
    expect(r).toContain('DeprecationWarning')
    expect(r).not.toContain('Possible EventEmitter') // 类比：完整警告全文不出现
    expect(r).toContain('tail') // 尾部正常输出保留
  })
  it('F-22 空名警告（P2）：(node:1) Warning: 形态不折叠（正则要求非空名）', () => {
    // 旧正则第二支 [A-Za-z]*Warning 允许空名——" Warning:" 出现空 tag 段；收紧后不匹配
    const r = foldNodeWarnings('(node:1) Warning: something')
    expect(r).toBe('(node:1) Warning: something') // 原样（不是 Node 内部警告形态）
  })
  it('F-22 单条警告移除后残留单空行清理（P2）', () => {
    const out = '(node:1) DeprecationWarning: x is deprecated\n\nnormal line'
    const r = foldNodeWarnings(out)
    // 警告行移除后紧跟的孤立空行应被清掉：tag + normal（无空行夹层）
    expect(r).not.toMatch(/^〔Node 内部警告已折叠：.*〕\n\n/)
    expect(r).toContain('normal line')
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

  it('F-39 超限落盘：.outputs/<toolUseId>.log 存全文，中截标记带路径（CC persist-to-disk）', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ecode-bash-out-'))
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)
    try {
      const sid = '2026-08-29T00-00-00-000Z-f39'
      const r = await bashTool.execute({ command: 'yes X | head -c 300' }, {
        ...ctx,
        maxOutputBytes: 64,
        toolUseId: 'toolu_f39',
        session: { getSessionId: () => sid },
      } as ToolContext)
      expect(r.content).toContain('完整输出已保存')
      expect(r.content).toContain('toolu_f39.log')
      const m = /已保存: (.+?\.log)/.exec(r.content)
      expect(m).not.toBeNull()
      const saved = readFileSync(m![1]!, 'utf8')
      expect(Buffer.byteLength(saved, 'utf8')).toBe(300) // 全文落盘（yes|head -c 300 恰 300 字节）
    } finally {
      spy.mockRestore()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('F-39 无会话信息（argv/测试兜底）不落盘：纯中截无路径标记', async () => {
    const r = await bashTool.execute({ command: 'yes X | head -c 300' }, {
      ...ctx,
      maxOutputBytes: 64,
    } as ToolContext)
    expect(r.content).toContain('已截断')
    expect(r.content).not.toContain('完整输出已保存')
  })
})


/** 探活：signal 0 不发信号只查存在（Windows 亦支持） */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 清场：防止红跑完留孤儿孙进程（挂 1<<30 interval 会驻留系统） */
function cleanup(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid)) return
  if (!alive(pid)) return
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    k.on('error', () => {})
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

describe('bashTool.execute 进程树终止（孙进程泄漏修复，M10 v1.3）', () => {
  it('超时杀整树：孙 node 进程一并终止（修复前仅杀 bash.exe，孙进程存活成孤儿）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-treekill-'))
    const marker = join(dir, 'grandchild.pid').split(String.fromCharCode(92)).join('/')
    let grandPid: number | undefined
    try {
      // 孙进程：写 pid 后挂起；父命令 sleep 30 保证必超时（2026-09-03 等待根治：timeout_ms 已是模型输入参数，非工具元数据）
      const cmd = `node -e "require('fs').writeFileSync('${marker}', String(process.pid)); setInterval(()=>{}, 1<<30)" & sleep 30`
      const r = await bashTool.execute({ command: cmd, timeout_ms: 1200 }, ctx)
      expect(r.is_error).toBe(true)
      expect(r.content).toContain('超时')
      expect(existsSync(marker)).toBe(true)
      grandPid = Number(readFileSync(marker, 'utf8'))
      expect(Number.isFinite(grandPid)).toBe(true)
      // 轮询等孙进程消失（上限 4s）——固定等待在持续负载下反复翻红（taskkill 复查补杀窗口）
      for (let i = 0; i < 40 && alive(grandPid); i++) await new Promise((res) => setTimeout(res, 100))
      expect(alive(grandPid)).toBe(false) // 修复前 true —— 孙进程泄漏
    } finally {
      cleanup(grandPid)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('abort 中断同样杀整树（孙进程一并终止）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-treekill-'))
    const marker = join(dir, 'grandchild.pid').split(String.fromCharCode(92)).join('/')
    let grandPid: number | undefined
    try {
      const cmd = `node -e "require('fs').writeFileSync('${marker}', String(process.pid)); setInterval(()=>{}, 1<<30)" & sleep 30`
      const controller = new AbortController()
      const p = bashTool.execute(
        { command: cmd, timeout_ms: 30_000 },
        { cwd: ctx.cwd, signal: controller.signal },
      )
      // 等 marker 出现（孙进程已起）再中断
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((res) => setTimeout(res, 100))
      // 树稳定期：taskkill /T 的树枚举在进程刚出生窗口有偶发漏杀（三层树 bash→中间 sh→node），
      // 真实场景命令至少跑数百毫秒才被中断——此处对齐真实时序，出生竞态的正解（Job Object）在 M12+ 观察区
      await new Promise((res) => setTimeout(res, 300))
      controller.abort()
      const r = await p
      expect(r.content).toContain('中断')
      // 轮询等孙进程消失（上限 4s）：固定 800ms 在持续测试负载下反复出现 taskkill
      // 复查补杀窗口超时（今天第 4 次翻红，隔离运行恒绿——负载相关；Job Object 正解仍在挂账）
      grandPid = Number(readFileSync(marker, 'utf8'))
      for (let i = 0; i < 40 && alive(grandPid); i++) await new Promise((res) => setTimeout(res, 100))
      expect(alive(grandPid)).toBe(false) // 修复前 true
    } finally {
      cleanup(grandPid)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('bash 超时自管（2026-09-03 等待根治：30s 写死 → 输入参数，默认 120s/上限 600s）', () => {
  it('timeout_ms 输入参数驱动内部定时器：短超时触发并杀树（is_error + 引导文案）', async () => {
    const r = await bashTool.execute(
      { command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30', timeout_ms: 600 },
      ctx,
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('命令超时 (600ms)')
    expect(r.content).toContain('timeout_ms')
  }, 10_000)

  it('契约锚：不再声明循环层 timeout_ms 元数据（自管超时——软超时不杀进程成孤儿）；schema 上限 600000', () => {
    expect(bashTool.timeout_ms).toBeUndefined()
    const props = bashTool.input_schema as { properties: Record<string, { maximum?: number; description?: string }> }
    expect(props.properties.timeout_ms?.maximum).toBe(600_000)
    expect(props.properties.timeout_ms?.description).toContain('120000')
    expect(props.properties.timeout_ms?.description).toContain('600000')
  })
})
