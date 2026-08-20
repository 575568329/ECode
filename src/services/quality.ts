/**
 * QualityGate：编辑后 lint/test 自动回喂（M9-P3，aider 质量闭环裁剪）。
 *
 * 触发：一轮工具中有 ≥1 个编辑类工具成功（write_file/edit_file）→ 轮末聚合跑一次
 * （同轮多编辑不重复；由 loop 的 afterTools 回调驱动，loop 只透传结果清单不认识 lint）。
 * 回喂：失败输出作为 user 文本消息追加（`[lint]`/`[test]` 前缀）——协议上 tool_result
 * 必须配对 tool_use（无主 result 会 400），信息性回喂走 user 文本，模型下一轮看到自纠。
 * 熔断：连续 2 次失败且输出无变化（模型修复无效）→ 停止自动跑 + warn 提示接手（防死循环烧钱）。
 * 全绿静默（不打扰）。
 */

import { createHash } from 'node:crypto'
import { isDangerousCommand, killTree, spawnShellCommand } from './proc.js'
import { matchesBlocked } from './sandbox.js'
import { loadConfig } from './config.js'

/** 触发回喂的编辑类工具 */
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])
/** 连续失败（输出无变化）熔断阈值 */
const CIRCUIT_BREAK_LIMIT = 2

export interface QualityCommands {
  lint?: string
  test?: string
}

export interface QualityRunOutcome {
  command: string
  exitCode: number
  output: string
}

export interface QualityGateOpts {
  commands: QualityCommands
  /** 命令执行器（注入便于测试）；抛错/超时由调用方在 runner 内处理为 exitCode 非 0 */
  run: (command: string) => Promise<QualityRunOutcome>
  warn?: (msg: string) => void
}

/**
 * 解析 lint/test 命令：**仅认用户显式配置**（lintCommand/testCommand）——undefined 与空串一律视为关闭。
 *
 * Why 安全默认（P0 修复）：旧实现会对 package.json scripts 做自动探测并在轮末自动执行
 * `npm run lint/test`——clone 一个恶意仓库（scripts.lint 写下载执行）再让 ECode 改个 typo，
 * 就能在无确认、不过危险黑名单、不过沙箱的前提下于轮末自动 RCE。自动探测路径已整体删除；
 * lint/test 自动回喂只信任用户自己写在 config 里的命令。
 */
export function detectQualityCommands(
  _cwd: string,
  override?: { lintCommand?: string; testCommand?: string },
): QualityCommands {
  const commands: QualityCommands = {}
  if (override?.lintCommand !== undefined && override.lintCommand !== '') commands.lint = override.lintCommand
  if (override?.testCommand !== undefined && override.testCommand !== '') commands.test = override.testCommand
  return commands
}

/** 回喂输出的最大长度（字符级截断，防长输出刷屏上下文） */
const FEEDBACK_MAX_CHARS = 4_000

export class QualityGate {
  private readonly commands: QualityCommands
  private readonly run: (command: string) => Promise<QualityRunOutcome>
  private readonly warn: (msg: string) => void
  /** 连续失败（输出无变化）计数；≥2 熔断 */
  private consecutiveFailures = 0
  private lastFailureHash = ''
  private _tripped = false

  constructor(opts: QualityGateOpts) {
    this.commands = opts.commands
    this.run = opts.run
    this.warn = opts.warn ?? (() => {})
  }

  /** 熔断态（停止自动跑；会话级——重启/新会话复位） */
  get tripped(): boolean {
    return this._tripped
  }

  /** 本轮聚合是否有失败（终审 P1-5：autoCommit 红灯不提交的判定信号） */
  private _lastRoundFailed = false
  get lastRoundFailed(): boolean {
    return this._lastRoundFailed
  }

  /** 配置全空（关闭态） */
  get disabled(): boolean {
    return this.commands.lint === undefined && this.commands.test === undefined
  }

  /**
   * 轮末聚合：本轮工具清单里有编辑成功才跑。返回回喂文本（undefined=全绿/不跑/已熔断且非本轮触发的失败）。
   * 熔断语义：第 2 次输出无变化的失败仍回喂（附熔断提示），此后 afterRound 短路。
   */
  async afterRound(tools: Array<{ name: string; isError: boolean }>): Promise<string | undefined> {
    this._lastRoundFailed = false
    if (this._tripped || this.disabled) return undefined
    const edited = tools.some((t) => EDIT_TOOLS.has(t.name) && !t.isError)
    if (!edited) return undefined

    const failures: string[] = []
    for (const [kind, command] of [
      ['lint', this.commands.lint],
      ['test', this.commands.test],
    ] as Array<['lint' | 'test', string | undefined]>) {
      if (command === undefined) continue
      try {
        const outcome = await this.run(command)
        if (outcome.exitCode !== 0) {
          failures.push(`[${kind}] ${command} 失败（exit ${outcome.exitCode}）：\n${truncateFeedback(outcome.output)}`)
        }
      } catch (e) {
        failures.push(`[${kind}] ${command} 启动失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (failures.length === 0) {
      this.consecutiveFailures = 0 // 全绿重置
      this.lastFailureHash = ''
      return undefined
    }
    this._lastRoundFailed = true

    const failureText = failures.join('\n\n')
    const hash = createHash('sha256').update(failureText).digest('hex')
    if (hash === this.lastFailureHash) this.consecutiveFailures += 1
    else {
      this.consecutiveFailures = 1
      this.lastFailureHash = hash
    }

    if (this.consecutiveFailures >= CIRCUIT_BREAK_LIMIT) {
      this._tripped = true
      this.warn('lint/test 连续 2 次失败且输出无变化（模型修复无效），已停止自动运行——请人工接手')
      return `${failureText}\n\n[quality] 已连续 ${this.consecutiveFailures} 次修复无效，此后不再自动运行 lint/test；请仔细分析上述输出后修复。`
    }
    return `${failureText}\n\n[quality] 请修复上述问题。`
  }
}

/** 回喂截断（字符级头尾保留） */
function truncateFeedback(s: string): string {
  if (s.length <= FEEDBACK_MAX_CHARS) return s === '' ? '(无输出)' : s
  const half = Math.floor(FEEDBACK_MAX_CHARS / 2)
  return `${s.slice(0, half)}\n…（中间已截断）\n${s.slice(-half)}`
}

/**
 * 默认 runner：shell 执行 + 60s 超时杀进程（cli/TuiApp 装配用；测试注入 mock runner）。
 *
 * 安全加固（P0 修复）：
 * - 执行前过 isDangerousCommand 与 matchesBlocked——命中即拒绝执行并给 notice 说明
 *   （自动回喂是免确认通道，必须与 bash 工具同标准；配置读不到 deny 清单时按空清单处理）。
 * - 超时用 killTree 树杀——npm run 类命令起孙进程，child.kill() 单点杀会泄漏孤儿。
 * blockedCommands 缺省读用户 config（cli 两处调用点不传参，保持签名兼容）；测试可显式注入。
 */
export function makeShellRunner(
  cwd: string,
  timeoutMs = 60_000,
  blockedCommands?: string[],
): (command: string) => Promise<QualityRunOutcome> {
  let blocked: string[]
  if (blockedCommands !== undefined) {
    blocked = blockedCommands
  } else {
    try {
      blocked = loadConfig().sandbox?.blockedCommands ?? []
    } catch {
      // 配置无效/读失败：与空壳配置同语义（无 deny 清单），不因此关闭 lint/test
      blocked = []
    }
  }
  return (command) => {
    // 危险命令 / blockedCommands 命中 → 拒绝 spawn，给可读 notice（exit 1 会走回喂/熔断链，
    // 用户最多看到两次提示后熔断告警——比静默跳过更诚实）
    if (isDangerousCommand(command) || matchesBlocked(command, blocked)) {
      return Promise.resolve({
        command,
        exitCode: 1,
        output: '[quality] 命令命中危险黑名单或 sandbox.blockedCommands，已拒绝自动执行——请检查 lintCommand/testCommand 配置是否指向了不受信任的命令',
      })
    }
    return new Promise((resolve) => {
      let child
      try {
        child = spawnShellCommand(command, cwd)
      } catch (e) {
        resolve({ command, exitCode: 1, output: `启动失败: ${e instanceof Error ? e.message : String(e)}` })
        return
      }
      let out = ''
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      const timer = setTimeout(() => {
        // 树杀（孙进程一并终止），不阻塞结果返回；已退出幂等
        void killTree(child)
        resolve({ command, exitCode: 124, output: `${out}
[quality] 超时（${Math.round(timeoutMs / 1000)}s）被终止` })
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ command, exitCode: code ?? 0, output: out })
      })
    })
  }
}

// —— M9-P7：LSP 诊断回喂接口位（占牌，实现视余量或 M10——依赖子进程/语言服务管理，重） ——

/** 诊断提供方（LSP 实现的接入契约：编辑后查询已装 server 的 diagnostics，与 lint 同通道回喂） */
export interface DiagnosticProvider {
  /** 查询文件诊断；未装 LSP server / 不支持该语言返回空（优雅降级） */
  diagnostics(file: string): Promise<Array<{ line: number; severity: 'error' | 'warning'; message: string }>>
}
