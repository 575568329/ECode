#!/usr/bin/env node
/**
 * ECode CLI 入口（M2）。职责（M14-C3① 拆分后）：argv 解析分流 + REPL/单次两模式驱动 +
 * 进程生命周期（信号/退出/优雅关闭）。装配见 ./assembly.ts，常驻 serve 见 ./serveMain.ts，
 * 终端光标见 ./cursor.ts。
 *
 * 两种模式：
 *   - 单次：`ecode "你的问题"` 或 `npm run dev -- "问题"` → M1 stdout 输出（脚本式，稳定）
 *   - REPL：`ecode` 或 `npm run dev` → Ink TUI（M2，替换 readline）
 *
 * argv 单次模式保留 M1 的 stdout 输出（脚本/管道友好，退出不清屏）；
 * REPL 是 M2 重点，用 Ink 全屏 TUI。
 *
 * ANSI 颜色（cli-highlight 代码高亮）靠 dev/start script 的 cross-env FORCE_COLOR=1
 * 在 Node 启动前注入（ESM import 是 hoisted，写在代码里会晚于 chalk 锁 level）。
 */
import { loadConfig, emptyShellConfig, type Config } from '../services/config.js'
import { JsonlLogger } from '../services/logger.js'
import { LogStore } from '../services/logstore.js'
import { taskRegistry } from '../services/tasks.js'
import { makeGracefulShutdown } from '../services/gracefulShutdown.js'
import { skillRegistry } from '../services/skill.js'
import { commandRegistry, registerBuiltinCommands } from '../commands/registry.js'
import { HostSession } from '../host/session.js'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { stripUntrustedAnsi } from '../tui/sanitize.js'
import { installAltScreenExitHook } from '../tui/AltScreen.js'
import { render } from 'ink'
import React from 'react'
import { TuiApp, type TuiAppDeps } from '../tui/TuiApp.js'
import { ensureDaemonAttach } from './daemon.js'
import { runPair, runDevices } from './pair.js'
import { runWechatLogin } from './wechatLogin.js'
import { makeAttachShellDeps } from './assembly.js'
import { makeDeps, type Deps } from './assembly.js'
import { serveStop, serveMode } from './serveMain.js'
import { parseArgv } from './args.js'
import { readFileSync } from 'node:fs'
import { hideTerminalCursor, stopCursorGuard, showTerminalCursor } from './cursor.js'
import type { HistoryStore } from '../services/history.js'
import type { HookRunner } from '../services/hooks/runner.js'
import type { McpManager } from '../services/mcp/manager.js'

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
async function runOnce(input: string, deps: Deps, approvalPolicy: 'ask' | 'auto-approve' = 'ask'): Promise<void> {
  // M12-B1：argv 切换为宿主消费方（同进程 InMemoryChannel + stdout 适配器）——
  // 与 TUI 走同一套装配/事件翻译（原内联装配退役）；行为增强：Stop hook/插话队列/轮末兜底随宿主获得
  // M13-W1：宿主取自 ProjectHost（makeDeps 已装配含 approvalPolicy——opts 前移）；无 project 的
  // 旧测试路径走内联构造兜底（行为与 M12 等价）
  const host =
    deps.project !== undefined
      ? deps.project.ensureDefault(deps.history.currentSessionId())
      : new HostSession({
          providerRegistry: deps.providerRegistry,
          tools: deps.tools,
          logger: deps.logger,
          history: deps.history,
          getConfig: () => deps.config,
          orchestrator: deps.orchestrator,
          skillListForPrompt: () => deps.skillRegistry.listForPrompt(),
          ...(deps.hookRunner != null ? { hookRunner: deps.hookRunner } : {}),
          ...(deps.checkpoint != null ? { checkpoint: deps.checkpoint } : {}),
          ...(deps.quality != null ? { quality: deps.quality } : {}),
          approvalPolicy,
          cwd: process.cwd(),
        })
  // B3：三桥宿主侧挂载（argv 无订阅者 → ask_user/权限/子代理副作用全 fail-closed——D1 语义；幂等）
  host.mountBridges()
  // D1 回归修复（2026-08-31 走查）：stdout 适配器是观察型订阅（canAnswer:false）——
  // 它只打印不应答。此前默认可应答订阅使 broker 的「零订阅者」判定永假：--yes 快速放行
  // 与 ask fail-closed 拒绝双双不可达，审批挂起至事件循环清空进程静默 exit 0。
  host.subscribe((ev) => {
    switch (ev.type) {
      // F-47：print 模式直写 stdout 完全绕过 Ink 净化层——不可信内容（LLM 文本/工具
      // 输出摘要）必须先 strip（--print "cat 恶意文件" 即可注入任意终端序列）
      case 'delta':
        process.stdout.write(stripUntrustedAnsi(ev.text))
        break
      case 'item/started':
        process.stdout.write(`\n⏺ ${ev.name}\n`)
        break
      case 'item/completed':
        process.stdout.write(`  ${ev.name} ${ev.isError ? '✗' : '✓'} ${stripUntrustedAnsi(ev.summary)}\n`)
        break
      case 'usage':
        deps.lastUsage.input = ev.input
        deps.lastUsage.output = ev.output
        deps.lastUsage.cacheRead = ev.cacheRead ?? 0
        deps.lastUsage.cacheCreation = ev.cacheCreation ?? 0
        process.stdout.write(`\n[tokens: in ${ev.input} / out ${ev.output}]\n`)
        break
      case 'warn':
        process.stdout.write(`\n⚠ ${stripUntrustedAnsi(ev.text)}\n`)
        break
      case 'notice':
        process.stdout.write(`\n${ev.level === 'error' ? '✗' : ev.level === 'warn' ? '⚠' : 'ℹ'} ${stripUntrustedAnsi(ev.text)}\n`)
        break
      case 'systemMsg':
        process.stdout.write(`\n${stripUntrustedAnsi(ev.text)}\n`)
        break
      case 'compacted':
        process.stdout.write('\n[已压缩对话]\n')
        break
      case 'error':
        process.stderr.write(`\n✗ ${ev.message}\n`)
        break
      default:
        break
    }
  }, { canAnswer: false })
  const r = await host.send({ op: 'prompt', text: input, mode: 'StartOrSteer' })
  if (!r.ok) {
    throw new Error(r.error)
  }
  await host.whenIdle()
  process.stdout.write('\n')
  host.dispose() // 审阅 P1-7：会话级任务表/审批收敛（缺它 argv 后台任务孤儿化）
}

async function main(): Promise<void> {
  // F-01：参数解析层（-v/-h/未知 flag 提前分流，零 LLM；serve/--yes/--history/位置参数语义不变）
  const argvRest0 = process.argv.slice(2)
  const parsed = parseArgv(argvRest0)
  if (parsed.mode === 'version') {
    const v = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    process.stdout.write(`${v}\n`)
    return
  }
  if (parsed.mode === 'help') {
    process.stdout.write(`${parsed.usage}\n`)
    return
  }
  if (parsed.mode === 'error') {
    process.stderr.write(`${parsed.message}\n`)
    process.exitCode = 1
    return
  }
  // R1：`ecode pair` / `ecode devices` 分流（设备配对面——不初始化 Ink/不碰 LLM；R2 起 async——守护感知）
  if (parsed.mode === 'pair') {
    process.exitCode = await runPair(parsed.pairArgs)
    return
  }
  if (parsed.mode === 'devices') {
    process.exitCode = await runDevices(parsed.devicesArgs)
    return
  }
  // R4：`ecode wechat-login` 分流（iLink 扫码登录——不初始化 Ink/不碰 LLM）
  if (parsed.mode === 'wechat-login') {
    process.exitCode = await runWechatLogin()
    return
  }
  // M12：`ecode serve` 分流（常驻宿主 HTTP——不初始化 Ink）
  if (parsed.mode === 'serve') {
    if (parsed.serveArgs[0] === 'stop') {
      await serveStop()
      return
    }
    await serveMode()
    return
  }
  // P1-16：logger + process handlers 提前到 loadConfig 前（配置失败也要记日志 + 全局兜底尽早挂）
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(process.cwd(), '.ecode', 'logs', `${sessionId}.jsonl`)
  const logStore = new LogStore(logPath, sessionId)
  const logger = new JsonlLogger(logStore)
  // M6：MCP 子进程清理（best-effort——exit 内不能 await；SDK close 发 SIGTERM）
  let mcpManagerRef: McpManager | null = null
  let sessionEndHook: HookRunner | null = null
  let inkApp: { unmount(): void } | undefined
  let historyRef: HistoryStore | null = null
  // 优雅关闭（M7 调研后采用：信号 handler / 双击退出 / argv 收尾共用——先同步恢复终端，
  // 再预算内 await SessionEnd hooks 与 MCP stop，failsafe 定时器兜底强退）
  const gracefulShutdown = makeGracefulShutdown({
    restoreTerminal: () => {
      stopCursorGuard() // 先停守卫——Ink 卸载收尾帧不再被追加 ?25l
      try {
        inkApp?.unmount()
      } catch {
        // 已卸载（TUI 关闭路径竞态）——恢复终端幂等
      }
      showTerminalCursor()
      // 恢复提示：本会话有内容时留一条重开命令（forkSession 后当前文件自包含全对话）。
      // 恢复的会话也成立（播种后 currentSessionId 即完整对话）；空会话不打扰。
      const history = historyRef
      if (history !== null && process.stdout.isTTY === true && history.restore(history.currentSessionId()).length > 0) {
        process.stdout.write(
          `\u001b[2m↩ 继续本次对话：ecode --history ${history.currentSessionId()}（应用内 /history 亦可）\u001b[22m\n`,
        )
      }
    },
    runSessionEndHooks: () =>
      sessionEndHook?.dispatch('SessionEnd', { event: 'SessionEnd', session_id: '' }) ?? Promise.resolve(),
    stopMcp: () => mcpManagerRef?.stop() ?? Promise.resolve(),
    stopTasks: () => {
      // dispose：杀树 + 清理本会话 task-*.log（P2：输出含命令原文不脱敏，不留残骸）
      taskRegistry.dispose()
      return Promise.resolve()
    },
  })
  // exit handler = 兜底层（graceful 路径已完成异步清理；此处覆盖 uncaught/restart 等
  // 未走 graceful 的退出：stopNow 同步杀 + 日志 flush。注册序 = 执行序，先杀再 flush；
  // 还光标 writeSync 同步落地，任何退出路径终端不留隐藏光标态）
  process.on('exit', () => {
    showTerminalCursor()
  })
  process.on('exit', () => {
    mcpManagerRef?.stopNow()
  })
  process.on('exit', () => {
    logger.info('system', 'shutdown', { exitCode: process.exitCode })
    logStore.close()
  })
  // 信号 → 优雅关闭（TUI 的 Ctrl+C 被 Ink 捕获不产生 SIGINT，走 useInterrupt 的 onExit；
  // 此处覆盖 argv 模式与渲染前的 Ctrl+C、外部 kill、Windows 的 taskkill/SIGBREAK）
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.once(sig, () => gracefulShutdown(0))
  }
  // P1-8：异常路径同杀子进程（stopNow 同步 SIGKILL——异步 stop 在这里跑不完）再 flush 日志
  process.on('uncaughtException', (e) => {
    logger.error('system', 'uncaught', { message: e.message, stack: e.stack })
    mcpManagerRef?.stopNow()
    logStore.close()
    process.exit(1)
  })
  process.on('unhandledRejection', (r) => {
    const msg = r instanceof Error ? r.message : String(r)
    const stack = r instanceof Error ? r.stack : undefined
    logger.error('system', 'unhandled_rejection', { message: msg, stack })
    mcpManagerRef?.stopNow()
    logStore.close()
    process.exit(1)
  })

  // D10：配置有效性判断。有效 → 正常跑；无效 → argv 报错退出 / REPL+banner
  let config: Config
  let banner: string | undefined
  try {
    config = loadConfig()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('system', 'config_load_failed', { message: msg })
    if ((parsed as { input: string }).input !== '') throw e // argv 非交互：报错退出（exit handler 同步 flush 日志）
    config = emptyShellConfig() // 空壳 P0-4：TuiApp 仍能渲染（banner + /setup 可用）
    banner = msg
  }

  logger.info('system', 'startup', {
    model: config.current.model,
    cwd: process.cwd(),
    logPath,
    node: process.version,
    platform: process.platform,
    providerType: config.providers[config.current.name]?.type,
  })

  // M13-W1：--yes 前移（approvalPolicy 经 makeDeps opts 进会话 broker——原 runOnce 构造参数前移到装配点）
  // F-01：--history/互斥/缺参校验已前移 parseArgv（此处直接消费结果）
  const autoYes = parsed.mode === 'repl' && parsed.autoYes

  // —— T 线 T3：交互 REPL 的 daemon 附着序（argv 单次模式不进 daemon——G-T3 豁免）——
  // 附着成功=TuiApp 用 MultiTransport（同会话双客户端）；拉起失败=降级 Embedded（顶栏提示）；
  // 版本不符=拒绝启动+提示（D-T1a：保住 daemon 里跑着的任务，绝不自动本地双开）
  const initialHistorySessionId = parsed.mode === 'repl' ? parsed.historySessionId : undefined
  if (parsed.mode === 'repl' && parsed.input === '') {
    registerBuiltinCommands() // 附着分支不经 makeDeps（那边幂等注册全局单例）——提前补齐命令面
    const outcome = await ensureDaemonAttach({
      logger,
      forceEmbedded: parsed.local || process.env.ECODE_FORCE_EMBEDDED === '1',
    })
    if (outcome.attached) {
      const shellDeps = makeAttachShellDeps(logger, config)
      // P1-4：附着态 skillRegistry 真件补 load（用户拍板：skill 数据归本地，同机直读同一目录——
      // 不 load 则 @ 补全/手动触发/SkillPanel 全空）
      await shellDeps.skillRegistry
        .load({ builtinCommandNames: commandRegistry.list().map((c) => c.name) })
        .catch(() => {})
      historyRef = shellDeps.history as HistoryStore
      logger.info('daemon', 'attached', { name: outcome.daemonName, project: process.cwd() })
      hideTerminalCursor()
      installAltScreenExitHook()
      const instance = render(
        React.createElement(TuiApp, {
          deps: shellDeps as unknown as TuiAppDeps,
          host: outcome.transport,
          // 附着成功提示走 initialNotice（底部 systemMsgs 统一通道，5s 自动消失）——
          // banner 是配置错误持久横幅，不该被这条常态信息占用（后台状态已有顶栏「后台运行中」常驻段）
          initialNotice: `ℹ 已附着后台服务（${outcome.daemonName}）——任务在后台持续运行，手机可继续操作`,
          initialHistorySessionId,
          onExit: () => gracefulShutdown(0),
        }),
        { exitOnCtrlC: false },
      )
      inkApp = instance
      return
    }
    if (outcome.versionMismatch) {
      process.stderr.write(`✗ ${outcome.reason}\n`)
      process.exit(1)
      return
    }
    if (outcome.reason !== '') banner = outcome.reason // 自动降级 Embedded——顶栏提示
  }

  const deps = makeDeps(config, logger, sessionId, process.cwd(), { approvalPolicy: autoYes ? 'auto-approve' : 'ask' })
  historyRef = deps.history
  // M10-P3 终审 P1-6：后台任务完成钩子——走近修改集快照兜底（bash 同款语义；无 git 时 warn 跳过）
  taskRegistry.onComplete = (t) => {
    void deps.checkpoint
      ?.snapshot(deps.history.currentSessionId(), [], { tool: `bash-bg:${t.command.slice(0, 40)}` })
      .catch(() => {})
  }
  mcpManagerRef = deps.mcpManager
  sessionEndHook = deps.hookRunner

  // M6 S-P8：skill 发现（项目级+用户级扫描；失败静默——skill 缺失不阻塞启动）
  await skillRegistry.load({ builtinCommandNames: commandRegistry.list().map((c) => c.name) }).catch(() => {})
  for (const w of skillRegistry.loadWarnings) logger.warn('skill', 'load_warning', { message: w })
  logger.info('skill', 'loaded', { count: skillRegistry.list().length })

  // M7 P-P6：plugin 资源接入（skills→addSource / mcp→命名空间 server / hooks→扩展注册表）
  const pluginWarnings = await deps.pluginLoader
    ?.loadAll(skillRegistry, deps.mcpManager)
    .catch((e: unknown) => [`plugin loadAll 失败：${e instanceof Error ? e.message : String(e)}`]) ?? []
  for (const w of pluginWarnings) logger.warn('plugin', 'load_warning', { message: w })
  if (deps.pluginLoader !== null) {
    logger.info('plugin', 'loaded', { count: deps.pluginLoader.list().length })
  }

  // argv 单次模式：M1 stdout 输出 → 跑一次退出（graceful：SessionEnd/MCP 清理走预算窗口）
  // D1（B2）：--yes 显式放行 tool-confirm 类审批（sensitive/mcp-permission 不豁免）；缺省 fail-closed
  // `--history <sessionId>`：REPL 启动即恢复指定会话（同 /history 语义——起新 sessionId 续写，D2），
  // 与位置参数（单次模式）互斥
  const initialInput = parsed.mode === 'repl' ? parsed.input : ''
  if (initialInput) {
    for (const w of deps.instructionWarnings) process.stderr.write(`⚠ ${w}
`)
    try {
      await runOnce(initialInput, deps, autoYes ? 'auto-approve' : 'ask') // policy 兜底（project 路径已在装配点生效）
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      gracefulShutdown(1)
      return
    }
    gracefulShutdown(0)
    return
  }

  // REPL 模式：Ink TUI（exitOnCtrlC:false，由 TuiApp 的 useInterrupt 自处理双击退出——
  // 双击走 gracefulShutdown：恢复终端 → SessionEnd hooks → MCP stop → exit）
  hideTerminalCursor()
  installAltScreenExitHook() // F-48：alt buffer 进程退出兜底（writeSync 1049l 防黑屏假死）
  const instance = render(
    React.createElement(TuiApp, {
      deps,
      banner,
      initialHistorySessionId,
      onRestart: () => restartProcess(instance, historyRef),
      onExit: () => gracefulShutdown(0),
    }),
    { exitOnCtrlC: false },
  )
  inkApp = instance
}

/**
 * /restart（拍板 ②）：unmount 恢复终端态 → spawn 新实例（argv 原样重放）→ 新实例接管终端。
 * 会话历史已由 HistoryStore 持久化，新实例 /history 可恢复。
 *
 * F-41：平台分流——POSIX 保持 detached（子进程组独立，父退出后子继续持有同一 tty，
 * 「父退子接管」语义成立）；**Windows 的 detached = CREATE_NEW_CONSOLE**——子进程开
 * 自己的新控制台窗口而非接管当前终端，父 exit 后用户回到 PS 提示符，观感即
 * 「重启失败退出了」（dogfood 实证 rpp-web 现场）。Windows 改 attach 等待：
 * 子进程继承当前控制台跑 TUI，父进程静默等其退出再退（Ctrl+C 是控制台广播，
 * 新旧进程同收同退，无残留）。
 */
function restartProcess(instance: { unmount(): void }, history: HistoryStore | null): void {
  try {
    instance.unmount()
  } catch {
    // unmount 竞态不阻塞重启
  }
  // 光标守卫随旧 TUI 一起撤（attach 等待期间旧进程仍存活——心跳每 500ms 压 ?25l，
  // 现阶段与新 TUI 藏光标意图一致无症状，但新进程一旦需要显示硬件光标即被压制）
  stopCursorGuard()
  const argv = process.argv.slice(1)
  // /restart 重放 --history 时换成当前会话 id：restore 后是 fork 新 id（含最新状态），
  // 原样重放旧值会退回恢复前的快照；恢复后未发言就重启的，先播种落盘重放才有文件
  const historyFlagIdx = argv.indexOf('--history')
  if (historyFlagIdx >= 0 && history !== null) {
    history.flushPendingSeed()
    argv[historyFlagIdx + 1] = history.currentSessionId()
  }
  if (process.platform === 'win32') {
    // attach 等待：接管当前控制台；父进程保持存活但已 unmount 静默，等子退出后收场。
    // 不再延迟 exit——立即退会让 PS 抢在子进程初始化前打印提示符，与 TUI 输出交错。
    // execArgv 必须显式拼进 argv——spawn 既无 execArgv 选项也不继承（实测子进程
    // execArgv=[]），tsx 形态下 loader（--import tsx/dist/loader.mjs）丢失 → node 裸跑
    // .ts，'.js' 后缀 import 解析失败 ERR_MODULE_NOT_FOUND（F-41 探针实证）
    const child = spawn(process.execPath, [...process.execArgv, ...argv], { cwd: process.cwd(), stdio: 'inherit' })
    child.on('error', (e) => {
      process.stderr.write(`✗ 重启失败：${e.message}（请手动重新运行）\n`)
      process.exit(1)
    })
    child.on('exit', (code) => process.exit(code ?? 0))
    // 释放 stdin 读取——conpty 输入投递给在读进程，父进程若占住 stdin，新实例键盘无响应
    process.stdin.pause()
    // destroy 副本句柄（pause 不够）：内核里 pending 的 console ReadFile 无法被 pause 取消，
    // 输入永远先喂给父句柄上那次读并被丢弃——子进程 Ink 输入管线挂载完好却永远等不到字节
    // （探针十连败实证；destroy 副本句柄令 pending read 失效，conpty 只剩子进程一个读者。
    //  用户真机报障「/restart 后无法输入」即此，npm run dev 形态复现→修复→探针转绿）
    try {
      process.stdin.destroy()
    } catch {
      // 已关闭/不可销毁——pause 兜底
    }
    return
  }
  // 同 Windows 分支：execArgv 拼进 argv（tsx loader 继承）
  const child = spawn(process.execPath, [...process.execArgv, ...argv], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
  })
  child.unref()
  child.on('error', (e) => {
    process.stderr.write(`✗ 重启失败：${e.message}（请手动重新运行）\n`)
  })
  setTimeout(() => process.exit(0), 200)
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
