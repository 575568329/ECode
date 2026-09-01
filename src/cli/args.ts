import { isValidSessionId } from '../host/session.js'

/**
 * F-01：CLI 参数解析层（纯函数，供 cli/index.ts 消费）。
 *
 * 修复：此前 `ecode --version` 等未识别 flag 会静默拼进 prompt 走 argv 单次模式烧 token
 * （dogfood 实证：`--stats` 记账 ¥0.029）。现在：
 *   - `-v`/`--version` → 输出 package.json version，exit 0（零 LLM）；
 *   - `-h`/`--help` → usage（REPL/单次/serve 三形态），exit 0；
 *   - 其余 `-` 开头 token → stderr `未知参数: xxx` + usage，exit 1；
 *   - `serve` 子命令族不变；非 `-` 开头参数继续走 argv 单次模式（保留脚本/管道用法）；
 *   - `--yes` / `--history <id>` 语义不变（含互斥/缺参校验，从 index.ts 前移至此）。
 */

export interface ArgvUsage {
  readonly usage: string
}

export type ArgvResult = ArgvUsage &
  (
    | { mode: 'version' }
    | { mode: 'help' }
    | { mode: 'serve'; serveArgs: string[] }
    | { mode: 'pair'; pairArgs: string[] }
    | { mode: 'devices'; devicesArgs: string[] }
    | { mode: 'wechat-login' }
    | { mode: 'error'; message: string }
    | { mode: 'repl'; input: string; autoYes: boolean; local: boolean; historySessionId: string | undefined }
  )

export const USAGE = [
  '用法：ecode [选项] [问题]',
  '',
  '形态：',
  '  ecode                 REPL 交互（Ink TUI）',
  '  ecode "你的问题"       单次执行：stdout 输出后退出（脚本/管道友好）',
  '  ecode serve           常驻宿主 HTTP 服务（serve stop 停止）',
  '  ecode pair [名字]      配对设备（web/手机接入凭据+offer 二维码）',
  '  ecode devices         配对设备列表（devices revoke <id> 吊销）',
  '  ecode wechat-login    微信 ClawBot 扫码登录（bot_token 写入 config.wechat）',
  '',
  '选项：',
  '  -v, --version         输出版本号并退出',
  '  -h, --help            显示本用法并退出',
  '      --yes             单次模式显式放行工具审批（fail-closed 缺省）',
  '      --history <id>    REPL 启动即恢复指定会话（与位置参数互斥；同义 --history=<id>）',
].join('\n')

export function parseArgv(argv: string[]): ArgvResult {
  // R1：设备配对面（pair/devices——不初始化 Ink/不碰 LLM）
  if (argv[0] === 'pair') return { usage: USAGE, mode: 'pair', pairArgs: argv.slice(1) }
  if (argv[0] === 'devices') return { usage: USAGE, mode: 'devices', devicesArgs: argv.slice(1) }
  // serve 子命令族：整段原样透传（serveMain 自行解析 --port 等）。
  // 契约锁测（批2a §10.3）：`serve --version` 不在 args 层分流——serve 自有解析，透传语义不变。
  if (argv[0] === 'wechat-login') return { usage: USAGE, mode: 'wechat-login' }
  if (argv[0] === 'serve') {
    return { usage: USAGE, mode: 'serve', serveArgs: argv.slice(1) }
  }

  // F-10.3 P0：`--history=<id>` 前置拆解为等价 `--history <id>`（白名单原本就豁免该前缀，
  // 但解析不认——`ecode --history=abc` 整串被当 prompt 发 LLM，F-01 同型复发）
  const normalized: string[] = []
  for (const a of argv) {
    if (a.startsWith('--history=') && a !== '--history=') {
      normalized.push('--history', a.slice('--history='.length))
    } else {
      normalized.push(a)
    }
  }
  argv = normalized

  // --history 前置校验（原 index.ts 逻辑前移）。
  // indexOf 重复 token 错位收口（审阅 B P2）：找的是**首个** --history，若出现两次
  // （`ecode --history a --history`）旧逻辑 `arr[i-1] !== '--history'` 会错把第二个的
  // 上下文当第一个的值判断——这里统一在首次命中处取值，多余的 --history 走下方白名单互斥报错。
  const historyFlagIdx = argv.indexOf('--history')
  const historySessionId = historyFlagIdx >= 0 ? argv[historyFlagIdx + 1] : undefined
  if (historyFlagIdx >= 0 && (historySessionId === undefined || historySessionId.startsWith('--'))) {
    return {
      usage: USAGE,
      mode: 'error',
      message: '用法：ecode --history <sessionId>（应用内 /history 可查会话列表）',
    }
  }
  // 重复 token 显式拒绝（审阅 B P2）：`--history a --history` 旧逻辑静默放行（第二个被
  // 白名单/过滤器吞掉）——重复即用户笔误，报错优于猜测
  if (historyFlagIdx >= 0 && argv.indexOf('--history') !== argv.lastIndexOf('--history')) {
    return { usage: USAGE, mode: 'error', message: '--history 只能出现一次' }
  }
  // 值形状校验（审阅 C P1：sessionId 会一路裸拼 sessions 目录路径，`..`/分隔符/绝对路径
  // = 任意 .jsonl 读原语——接 host/session 同款 isValidSessionId 白名单，CLI 路径不再裸拼）
  if (historyFlagIdx >= 0 && historySessionId !== undefined && !isValidSessionId(historySessionId)) {
    return {
      usage: USAGE,
      mode: 'error',
      message: `会话 id 非法：${historySessionId}（应为 2026-08-27T22-31-05-123Z 形态，/history 可查）`,
    }
  }

  // 位置参数 = 排除已知 flag 与 --history 的值（indexOf 换 lastIndexOf 语义修正：
  // 原实现 `arr[i-1] !== '--history'` 在重复 token 时会把第一个 --history 的判定
  // 挂在最后一个索引上；此处按 token 自身与前一个 token 判定，语义稳定）
  const positional = argv
    .filter((a, i, arr) => a !== '--yes' && a !== '--local' && a !== '--history' && arr[i - 1] !== '--history')
    .join(' ')
    .trim()

  if (historyFlagIdx >= 0 && positional !== '') {
    return { usage: USAGE, mode: 'error', message: '✗ --history 与位置参数（单次执行模式）互斥，二选一' }
  }

  // flag 白名单校验：-v/-h/--version/--help/--yes/--history 之外一律拒绝。
  // 版本优先序（批2a 声明）：version > help > 其他——首个命中即返回，与下方顺序一致。
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-v' || a === '--version') return { usage: USAGE, mode: 'version' }
    if (a === '-h' || a === '--help') return { usage: USAGE, mode: 'help' }
    if (a.startsWith('-') && a !== '--yes' && a !== '--local' && a !== '--history' && argv[i - 1] !== '--history') {
      return { usage: USAGE, mode: 'error', message: `未知参数: ${a}\n${USAGE}` }
    }
  }

  return {
    usage: USAGE,
    mode: 'repl',
    input: positional,
    autoYes: argv.includes('--yes'),
    /** T3：--local 跳过 daemon 直接 Embedded（附着失败自动降级语义见入口序） */
    local: argv.includes('--local'),
    historySessionId,
  }
}
