/**
 * bash 工具（副作用）：执行 shell 命令。
 *
 * 详设 §2.3 安全约束。M1 最小版（plan 决策）：
 *   ✅ timeout 自管（输入 timeout_ms，默认 120s/上限 600s；超时杀整树转 is_error——
 *      2026-09-03 等待根治：30s 写死曾把模型逼进后台化+短 wait 轮询撞 loop-guard 误伤；
 *      去掉循环层 timeout_ms 元数据同时消除「软超时不杀进程」的孤儿面）
 *   ✅ cwd 约束（在 ctx.cwd 执行）
 *   ✅ 退出码非 0 正常返回（含 stderr + 退出码，交 LLM 判断，recoverable）
 *   ✅ AbortSignal（中断杀进程）
 *   ⬜ 危险命令拦截 / 30KB 头尾中截 → 留 M3
 *
 * 跨平台（详设 §4.6）：Windows 显式 Git Bash（SHELL 缺省回退 bash.exe），
 * 非 Windows 用系统 sh。按 process.platform 探测，不写死。
 */

import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool } from '../interface.js'
import { isDangerousCommand, killTree, spawnShellCommand } from '../../services/proc.js'
import { taskRegistry, TASK_OUTPUT_MAX_WAIT_MS } from '../../services/tasks.js'

/**
 * 前台命令超时（2026-09-03 等待根治）：30s → 默认 120s（对标 CC DEFAULT_TIMEOUT_MS /
 * opencode 默认 2min）+ 模型可传 timeout_ms 放大到 600s（对标 CC MAX_TIMEOUT_MS）。
 * 全量测试/构建此前因 30s 写死必然超时 → 模型被迫 run_in_background + 短 wait 轮询 →
 * 撞 loop-guard 同参误伤（真机 8 连发实证）。
 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000
export const BASH_MAX_TIMEOUT_MS = 600_000

interface ExecResult {
  content: string
  is_error?: boolean
}

/** 输出截断缺省阈值（config `bashMaxOutputBytes` 可配；缺省 50KB——F-39 对标 CC
 *  toolLimits.DEFAULT_MAX_RESULT_SIZE_CHARS 50K chars 落盘阈值，原 30KB 对标的是 CC 旧值）。 */
export const BASH_MAX_OUTPUT_BYTES = 50_000

/** 危险命令拦截（黑名单收敛在 services/proc.ts，hook 执行体共用同一份——M7 H5）。 */
export function isDangerous(command: string): boolean {
  return isDangerousCommand(command)
}

/** 输出超阈值时头尾各半中截（§5.1：防刷屏 + 防 LLM 编造截断内容）。
 *  F-39：savedPath 非空时中截标记带落盘路径（CC persist-to-disk 同策略——完整输出
 *  不丢，模型/用户可 read_file 回看），limit 显式传入接通 config `bashMaxOutputBytes`
 *  （此前 30_720 硬编码、config 字段悬空零消费）。 */
export function truncateOutput(s: string, limit = BASH_MAX_OUTPUT_BYTES, savedPath?: string): string {
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes <= limit) return s
  const half = Math.floor(limit / 2)
  const buf = Buffer.from(s, 'utf8')
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(bytes - half).toString('utf8')
  const omitted = bytes - limit
  const marker =
    savedPath !== undefined
      ? `…（中间 ${omitted} 字节已截断。完整输出已保存: ${savedPath}——可用 read_file 查看，不要编造截断内容）`
      : `…（中间 ${omitted} 字节已截断，需要完整用 read_file/grep，不要编造）`
  return `${head}\n${marker}\n${tail}`
}

/**
 * F-22（批2b）：Node 内部警告折叠——MaxListenersExceededWarning 等进程级警告对 LLM 是
 * 噪声（还可能很长）且用户无需行动。折叠为一行提示不直打全文（原文走 stderr 语义丢弃——
 * 这类警告来自 ECode 自身或子进程的 listener 管理，不是命令的输出内容）。
 */
// eslint-disable-next-line no-control-regex
const NODE_INTERNAL_WARNING = /^\(node:\d+\)\s+([\w]+Warning|[A-Za-z]+\w*Warning):.*$/gm

export function foldNodeWarnings(s: string): string {
  if (!s.includes('(node:')) return s
  const warnings = new Set<string>()
  let folded = s.replace(NODE_INTERNAL_WARNING, (_m, name: string) => {
    warnings.add(name)
    return '' // 先移除，行清理在后
  })
  if (warnings.size === 0) return s
  // 清掉移除后留下的空行残迹（P2：连续空行收敛为一行 + 单条警告行移除后的孤立尾部空行清理）
  folded = folded
    .replace(/^[ \t]*\n(?:[ \t]*\n)+/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n[ \t\n]+$/, '\n')
    .replace(/\n{3,}/g, '\n\n')
  const tag = `〔Node 内部警告已折叠：${[...warnings].join('、')}——非命令输出，可忽略〕`
  return folded === '' || folded.trim() === '' ? tag : `${tag}\n${folded}`
}

export const bashTool: Tool = {
  name: 'bash',
  description: '执行 shell 命令（Git Bash / sh）。命令在当前工作目录执行。退出码非 0 时输出含 stderr 和退出码。',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell 命令' },
      timeout_ms: {
        type: 'number',
        minimum: 1,
        maximum: BASH_MAX_TIMEOUT_MS,
        description: `可选超时毫秒数（默认 ${BASH_DEFAULT_TIMEOUT_MS}、最大 ${BASH_MAX_TIMEOUT_MS}，仅前台生效——run_in_background 忽略）——长命令（全量测试/构建）显式放大；超时杀整树`,
      },
      run_in_background: {
        type: 'boolean',
        description: 'true=后台运行（仅持续型/长命令用——dev server 等不退出进程，或预计超 2 分钟的构建）：立即返回 task_id，用 task_output 读输出、task_stop 停止。秒级返回的短命令（git show/grep 等）直接同步跑，转后台徒增 task_output 往返',
      },
    },
    required: ['command'],
  },
  readonly: false,

  async execute(args, ctx) {
    const { command, run_in_background } = args as { command: string; run_in_background?: boolean }
    // 危险命令拦截（D4：正则黑名单，命中直接 is_error，不 spawn）
    if (isDangerous(command)) {
      return { content: `危险命令已拦截：${command}`, is_error: true }
    }
    // M9-P4：沙箱校验（read-only 整体拒 / blockedCommands 全档硬拒；confirm/allow 归 loop confirm 层）
    const bashGate = ctx.sandbox?.checkBash(command)
    if (bashGate !== undefined && bashGate.action === 'deny') {
      return { content: bashGate.reason, is_error: true }
    }
    // M10-P3：后台分流（危险命令与沙箱校验照走——黑名单不因后台豁免）
    if (run_in_background === true) {
      // 审阅修复（安全席 P2·二轮）+实施审阅重设：后台命令同样走基线对（begin 拍写前快照记 seq 锚）——原分流早于快照，
      // npm install/构建类后台写文件对 /rewind 完全失明（走 gitDirtyFiles 兑底同款）
      let bgBaseline: { sessionId: string; pre: string[]; seq: number | null } | null = null
      if (ctx.bashBaselineBegin !== undefined) {
        bgBaseline = await ctx.bashBaselineBegin().catch(() => null)
      } else {
        try {
          await ctx.onBeforeWrite?.([], 'bash-background')
        } catch {
          /* 快照失败静默继续 */
        }
      }
      const started = (ctx.tasks ?? taskRegistry).start(command, ctx.cwd)
      if (!started.ok) return { content: started.reason, is_error: true }
      // 二轮补遗：后台命令同样补录启动期差集（长跑命令后续产物由 task_output 轮外的
      // 下一次写前快照自然吸收；此钩子覆盖「先写文件再长跑」的常见形态）
      void ctx.bashBaselineEnd?.(bgBaseline).catch(() => {})
      return {
        content: `后台任务已启动：#${started.task.id}（输出文件 ${started.task.outputFile}）——用 task_output("${started.task.id}") 读增量输出，等新输出用大 wait_ms（≤${TASK_OUTPUT_MAX_WAIT_MS}）一次等到、勿短间隔连发（会触发 loop-guard 同参检测）；完成时会在下轮通知`,
      }
    }
    // M9-P1 写前快照 + 二轮 absent 兜底基线合一：begin 一次 git status 同时拍写前快照
    // （pre 集即快照路径）并记 seq 锚——基线实例随调用走不落共享槽（实施审阅 3×P1 重设）。
    // 兼容：未提供基线对的装配方（旧测试 fake ctx）回退原 onBeforeWrite 路径
    let bashBaseline: { sessionId: string; pre: string[]; seq: number | null } | null = null
    if (ctx.bashBaselineBegin !== undefined) {
      bashBaseline = await ctx.bashBaselineBegin().catch(() => null)
    } else {
      try {
        await ctx.onBeforeWrite?.([], 'bash')
      } catch {
        /* 快照失败静默继续（装配方 warn 已记） */
      }
    }
    // 审阅 P1（三席交叉）：0/负数超时无意义（「0=不限时」心智误传）——schema minimum:1 在
    // loop 层 AJV 已拒，此处 >0 守卫是绕过校验直调（测试/内部）的防御纵深；上界 Math.min 同理
    const rawTimeout = (args as { timeout_ms?: number }).timeout_ms
    const timeout =
      rawTimeout !== undefined && rawTimeout > 0
        ? Math.min(rawTimeout, BASH_MAX_TIMEOUT_MS)
        : BASH_DEFAULT_TIMEOUT_MS

    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawnShellCommand(command, ctx.cwd)
      } catch (e) {
        resolve({ content: `启动失败: ${e instanceof Error ? e.message : String(e)}`, is_error: true })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      // 中断：abort 杀进程（P2 修复：done 里摘除监听器——命令正常结束后 ctx.signal 仍长生命周期，
      // 残留监听器会让信号持有闭包引用、长会话下逐次累积泄漏）
      const onAbort = (): void => done({ content: '命令被中断', is_error: true })
      const done = (res: ExecResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        // 杀整树（孙进程一并终止——npm 类命令的子进程不再泄漏；已退出幂等）。不阻塞返回
        void killTree(child)
        // 二轮补遗（bash absent 兜底）：执行后差集补录（新建文件进最近快照点 absent 基线）。
        // fire-and-forget——结果已定，兜底失败不阻塞返回（amendAbsent 内部链上串行）
        void ctx.bashBaselineEnd?.(bashBaseline).catch(() => {})
        resolve(res)
      }

      const timer = setTimeout(
        () =>
          done({
            content: `命令超时 (${timeout}ms)——需更久请加大 timeout_ms（上限 ${BASH_MAX_TIMEOUT_MS}）或改用 run_in_background=true 后台跑`,
            is_error: true,
          }),
        timeout,
      )

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (e) => done({ content: `执行失败: ${e.message}`, is_error: true }))
      child.on('close', (code) => {
        // 合并 stdout + stderr（若有）；退出码非 0 时附退出码（recoverable，交 LLM 判断）
        const parts: string[] = []
        if (stdout) parts.push(stdout)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (code !== 0) parts.push(`[退出码 ${code}]`)
        const raw = parts.join('\n') || '(无输出)'
        const limit = ctx.maxOutputBytes ?? BASH_MAX_OUTPUT_BYTES
        // F-39（CC persist-to-disk 同策略）：会话内超限输出落盘 ~/.ecode/sessions/<sid>.outputs/
        // ——LLM/用户经 read_file 路径回看完整输出（中截的中间部分不再丢失）。
        // 会话信息不可得（argv 单会话兜底/测试）或写失败 → 退化为纯中截，不阻断。
        let savedPath: string | undefined
        const sid = ctx.session?.getSessionId?.()
        // 审阅 S4：toolUseId 来自 provider 流——拼进落盘路径前过白名单（`../../x` 形 id
        // 即越界写原语）；不匹配退化纯中截（fail-safe，不阻断输出）
        const toolUseIdSafe = ctx.toolUseId !== undefined && /^[\w.-]{1,128}$/.test(ctx.toolUseId)
        if (toolUseIdSafe && sid !== undefined && Buffer.byteLength(raw, 'utf8') > limit) {
          try {
            const outDir = path.join(os.homedir(), '.ecode', 'sessions', `${sid}.outputs`)
            fs.mkdirSync(outDir, { recursive: true })
            savedPath = path.join(outDir, `${ctx.toolUseId}.log`)
            fs.writeFileSync(savedPath, raw, 'utf8')
          } catch {
            savedPath = undefined
          }
        }
        done({ content: foldNodeWarnings(truncateOutput(raw, limit, savedPath)) })
      })

      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  },
}
