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
    | { mode: 'error'; message: string }
    | { mode: 'repl'; input: string; autoYes: boolean; historySessionId: string | undefined }
  )

export const USAGE = [
  '用法：ecode [选项] [问题]',
  '',
  '形态：',
  '  ecode                 REPL 交互（Ink TUI）',
  '  ecode "你的问题"       单次执行：stdout 输出后退出（脚本/管道友好）',
  '  ecode serve           常驻宿主 HTTP 服务（serve stop 停止）',
  '',
  '选项：',
  '  -v, --version         输出版本号并退出',
  '  -h, --help            显示本用法并退出',
  '      --yes             单次模式显式放行工具审批（fail-closed 缺省）',
  '      --history <id>    REPL 启动即恢复指定会话（与位置参数互斥）',
].join('\n')

export function parseArgv(argv: string[]): ArgvResult {
  // serve 子命令族：整段原样透传（serveMain 自行解析 --port 等）
  if (argv[0] === 'serve') {
    return { usage: USAGE, mode: 'serve', serveArgs: argv.slice(1) }
  }

  // --history 前置校验（原 index.ts 逻辑前移）
  const historyFlagIdx = argv.indexOf('--history')
  const historySessionId = historyFlagIdx >= 0 ? argv[historyFlagIdx + 1] : undefined
  if (historyFlagIdx >= 0 && (historySessionId === undefined || historySessionId.startsWith('--'))) {
    return {
      usage: USAGE,
      mode: 'error',
      message: '用法：ecode --history <sessionId>（应用内 /history 可查会话列表）',
    }
  }

  // 位置参数 = 排除已知 flag 与 --history 的值
  const positional = argv
    .filter((a, i, arr) => a !== '--yes' && a !== '--history' && arr[i - 1] !== '--history')
    .join(' ')
    .trim()

  if (historyFlagIdx >= 0 && positional !== '') {
    return { usage: USAGE, mode: 'error', message: '✗ --history 与位置参数（单次执行模式）互斥，二选一' }
  }

  // flag 白名单校验：-v/-h/--version/--help/--yes/--history 之外一律拒绝
  for (const a of argv) {
    if (a === '-v' || a === '--version') return { usage: USAGE, mode: 'version' }
    if (a === '-h' || a === '--help') return { usage: USAGE, mode: 'help' }
    if (a.startsWith('-') && a !== '--yes' && a !== '--history' && !a.startsWith('--history=') && argv[argv.indexOf(a) - 1] !== '--history') {
      return { usage: USAGE, mode: 'error', message: `未知参数: ${a}\n${USAGE}` }
    }
  }

  return {
    usage: USAGE,
    mode: 'repl',
    input: positional,
    autoYes: argv.includes('--yes'),
    historySessionId,
  }
}
