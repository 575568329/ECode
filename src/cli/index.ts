#!/usr/bin/env node
/**
 * ECode CLI 入口（M2）。
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

import { loadConfig, buildProviderReq, emptyShellConfig, type Config } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { OpenaiProvider } from '../providers/openai.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { readFileTool } from '../tools/builtin/read_file.js'
import { bashTool } from '../tools/builtin/bash.js'
import { lsTool } from '../tools/builtin/ls.js'
import { globTool } from '../tools/builtin/glob.js'
import { grepTool } from '../tools/builtin/grep.js'
import { writeFileTool } from '../tools/builtin/write_file.js'
import { editFileTool } from '../tools/builtin/edit_file.js'
import { JsonlLogger } from '../services/logger.js'
import { LogStore } from '../services/logstore.js'
import { FileHistoryStore } from '../services/history.js'
import { runLoop } from '../core/loop.js'
import { buildSystemPrompt } from '../core/system.js'
import { join } from 'node:path'
import { render } from 'ink'
import React from 'react'
import { TuiApp } from '../tui/TuiApp.js'
import { registerBuiltinCommands } from '../commands/registry.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import type { Message } from '../core/types.js'

interface Deps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
}

function makeDeps(config: Config, logger: Logger, sessionId: string): Deps {
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  providerReg.register(new OpenaiProvider())
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)
  toolReg.register(lsTool)
  toolReg.register(globTool)
  toolReg.register(grepTool)
  toolReg.register(writeFileTool)
  toolReg.register(editFileTool)
  return {
    providerRegistry: providerReg,
    tools: toolReg,
    logger,
    history: new FileHistoryStore({ sessionId, model: config.current.model }),
    config,
  }
}

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
async function runOnce(messages: Message[], input: string, deps: Deps): Promise<void> {
  await runLoop(messages, input, {
    provider: deps.providerRegistry.getByType(deps.config.providers[deps.config.current.name].type),
    tools: deps.tools,
    logger: deps.logger,
    history: deps.history,
    callbacks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: (name) => process.stdout.write(`\n⏺ ${name}\n`),
      onToolResult: (_id, name, r) => {
        const firstLine = r.content.split('\n')[0]?.slice(0, 80) ?? ''
        process.stdout.write(`  ${name} ${r.is_error ? '✗' : '✓'} ${firstLine}\n`)
      },
      onUsage: (inp, out) => process.stdout.write(`\n[tokens: in ${inp} / out ${out}]\n`),
      onWarn: (m) => process.stdout.write(`\n⚠ ${m}\n`),
    },
    providerReq: buildProviderReq(deps.config),
    system: buildSystemPrompt(),
    maxIterations: deps.config.maxIterations,
    toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
  })
  process.stdout.write('\n')
}

async function main(): Promise<void> {
  // D10：配置有效性判断（不分首次/非首次）。有效 → 正常跑；无效 → argv 报错退出 / REPL+banner
  let config: Config
  let banner: string | undefined
  try {
    config = loadConfig()
  } catch (e) {
    if (process.argv.slice(2).join(' ').trim()) throw e // argv 非交互：报错退出（D6）
    config = emptyShellConfig() // 空壳 P0-4：TuiApp 仍能渲染（banner + /setup 可用）
    banner = e instanceof Error ? e.message : String(e)
  }
  registerBuiltinCommands()

  // LogStore：JSONL 落盘 <cwd>/.ecode/logs/<sessionId>.jsonl（项目级，运行 trace；D12：ephemeral 数据跟项目走）
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(process.cwd(), '.ecode', 'logs', `${sessionId}.jsonl`)
  const logStore = new LogStore(logPath, sessionId)
  const logger = new JsonlLogger(logStore)
  logger.info('system', 'startup', {
    model: config.current.model,
    cwd: process.cwd(),
    logPath,
    node: process.version,
    platform: process.platform,
    providerType: config.providers[config.current.name]?.type,
  })
  process.on('exit', () => {
    logger.info('system', 'shutdown', { exitCode: process.exitCode })
    logStore.close()
  })
  // 崩溃兜底：未捕获异常/拒绝，记 error + 同步 flush 后退（避免丢最后一批排查日志）
  process.on('uncaughtException', (e) => {
    logger.error('system', 'uncaught', { message: e.message, stack: e.stack })
    logStore.close()
    process.exit(1)
  })
  process.on('unhandledRejection', (r) => {
    const msg = r instanceof Error ? r.message : String(r)
    const stack = r instanceof Error ? r.stack : undefined
    logger.error('system', 'unhandled_rejection', { message: msg, stack })
    logStore.close()
    process.exit(1)
  })

  const deps = makeDeps(config, logger, sessionId)

  // argv 单次模式：M1 stdout 输出 → 跑一次退出
  const initialInput = process.argv.slice(2).join(' ').trim()
  if (initialInput) {
    const messages: Message[] = []
    try {
      await runOnce(messages, initialInput, deps)
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  // REPL 模式：Ink TUI（exitOnCtrlC:false，由 TuiApp 的 useInterrupt 自处理双击退出）
  render(React.createElement(TuiApp, { deps, banner }), { exitOnCtrlC: false })
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
