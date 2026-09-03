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
    expect(rest).toEqual({ mode: 'repl', input: '', autoYes: false, local: false, historySessionId: undefined })
  })

  it('T3：--local → REPL 附 local 标记（跳过 daemon 直接 Embedded）', () => {
    const r = parseArgv(['--local'])
    expect(r.mode).toBe('repl')
    expect((r as { local?: boolean }).local).toBe(true)
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
    const r = parseArgv(['--history', '2026-08-27T22-31-05-123Z'])
    expect(r.mode).toBe('repl')
    if (r.mode === 'repl') expect(r.historySessionId).toBe('2026-08-27T22-31-05-123Z')
  })

  it('--history 缺参 / 与位置参数互斥 → error', () => {
    expect(parseArgv(['--history']).mode).toBe('error')
    expect(parseArgv(['--history', '2026-08-27T22-31-05-123Z', '问题']).mode).toBe('error')
  })

  // ---- 批2a §10.3（P0 回归修复）：--history= 前缀与值校验 ----

  it('--history=<id> 等价拆解（修复前整串被当 prompt 发 LLM——F-01 同型复发）', () => {
    const r = parseArgv(['--history=2026-08-27T22-31-05-123Z'])
    expect(r.mode).toBe('repl') // 修复前：input='--history=...' 整串走单次模式
    if (r.mode === 'repl') {
      expect(r.historySessionId).toBe('2026-08-27T22-31-05-123Z')
      expect(r.input).toBe('')
    }
  })

  it('--history= 与位置参数互斥 → error（拆解后走同一条互斥校验）', () => {
    expect(parseArgv(['--history=2026-08-27T22-31-05-123Z', '问题']).mode).toBe('error')
  })

  it('--history= 空值 → error（不是静默当 prompt）', () => {
    expect(parseArgv(['--history=']).mode).toBe('error')
  })

  it('--history 值形状校验（sessionId 裸拼 sessions 路径，防路径穿越原语）→ 非法 error', () => {
    // 路径穿越 / 分隔符 / 非时间戳形态一律拒绝（isValidSessionId 白名单）
    expect(parseArgv(['--history', 'abc']).mode).toBe('error') // 旧用例行为变化：裸词 id 不再放行
    expect(parseArgv(['--history', '../config']).mode).toBe('error')
    expect(parseArgv(['--history', '2026-08-27/../../etc/x']).mode).toBe('error')
    expect(parseArgv(['--history=../../etc/passwd']).mode).toBe('error')
    // 合法形态（ISO 时间戳；飞书带 8 位随机后缀）仍放行
    expect(parseArgv(['--history', '2026-08-27T22-31-05-123Z-abcd1234']).mode).toBe('repl')
  })

  it('重复 --history token 不再错位（旧 indexOf 判定把第一个的值挂到最后一个索引上）', () => {
    // `--history <合法id> --history`：第二个 --history 缺值按未知/缺参 error，不得静默放行为 repl
    const r = parseArgv(['--history', '2026-08-27T22-31-05-123Z', '--history'])
    expect(r.mode).toBe('error')
  })

  it('重复 --history 双值形态 → 显式「只能出现一次」message（批2c：锁死 message 不再静默放行）', () => {
    // `--history <合法id> --history <合法id>`：两个都有合法值，旧逻辑第二个被过滤器吞掉静默放行
    // ——现在必须 error 且 message 指向「只能出现一次」（用户笔误可自查，不靠猜）
    const r = parseArgv(['--history', '2026-08-27T22-31-05-123Z', '--history', '2026-08-27T22-31-05-999Z'])
    expect(r.mode).toBe('error')
    if (r.mode === 'error') expect(r.message).toContain('只能出现一次')
  })

  it('version 优先序锁测（批2c）：-v 先于 -h/未知 flag 命中——`ecode -v -h`/`ecode --version --bogus` 输出版本而非 help/报错', () => {
    // args.ts 白名单循环声明 version > help > 其他；此前无直接用例锁该顺序（防未来重排静默变行为）
    expect(parseArgv(['-v', '-h']).mode).toBe('version')
    expect(parseArgv(['--version', '--bogus']).mode).toBe('version')
    expect(parseArgv(['-h', '--bogus']).mode).toBe('help') // help 同样先于未知 flag
    // 未知 flag 在前则先报错（白名单循环自左向右首个命中——顺序即优先序，不跨位拦截）
  })

  it('serve --version 语义锁测：args 层不分流，serve 子命令族整段透传（serveMain 自行解析）', () => {
    const r = parseArgv(['serve', '--version'])
    expect(r.mode).toBe('serve')
    if (r.mode === 'serve') expect(r.serveArgs).toEqual(['--version'])
  })

  it('已知的非 flag 语义不被误伤：负数等以 - 开头的单字符除外仍报错（只白名单 -v/-h）', () => {
    expect(parseArgv(['-f']).mode).toBe('error')
  })
})

// 防漂移方案 §4.4（F4/G4 配套）：USAGE 静态串须覆盖 parseArgv 实际接受的全部白名单 flag。
// 白名单与 USAGE 同在 args.ts——此处按「字面 flag 列表」对账（宽松含词，方案 §4.1 同原则：
// 只漏报不误报，漏报=USAGE 少写一行，正是 G4 的形态）。
describe('活文档防漂移：USAGE 覆盖全部 CLI flag（清单 §4.4）', () => {
  const FLAGS = ['--version', '--help', '--yes', '--history', '--local'] as const
  it('USAGE 文本包含 parseArgv 白名单的每个 flag', () => {
    const { usage } = parseArgv([])
    const missing = FLAGS.filter((f) => !usage.includes(f))
    expect(
      missing,
      `USAGE 缺 flag 行：${missing.join(', ')}——补 src/cli/args.ts USAGE（-v/-h 形态也须可见）`,
    ).toEqual([])
  })
})
