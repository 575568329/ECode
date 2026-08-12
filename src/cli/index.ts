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

import { loadConfig, type M1Config } from '../services/config.js'
import { AnthropicProvider } from '../providers/anthropic.js'
import { LLMProviderRegistryImpl } from '../providers/registry.js'
import { ToolRegistryImpl } from '../tools/registry.js'
import { readFileTool } from '../tools/builtin/read_file.js'
import { bashTool } from '../tools/builtin/bash.js'
import { ConsoleLogger } from '../services/logger.js'
import { NoopHistoryStore } from '../services/history.js'
import { runLoop } from '../core/loop.js'
import { render } from 'ink'
import React from 'react'
import { TuiApp } from '../tui/TuiApp.js'
import { registerBuiltinCommands } from '../commands/registry.js'
import type { LLMProvider } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import type { Message } from '../core/types.js'

const SYSTEM_PROMPT = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}
回复用中文。`

interface Deps {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  cfg: M1Config
}

function makeDeps(cfg: M1Config): Deps {
  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)
  return {
    provider: providerReg.getByType(cfg.type),
    tools: toolReg,
    logger: new ConsoleLogger(),
    history: new NoopHistoryStore(),
    cfg,
  }
}

/** argv 单次模式：M1 stdout 输出（流式打印 + 工具摘要）。 */
async function runOnce(messages: Message[], input: string, deps: Deps): Promise<void> {
  await runLoop(messages, input, {
    provider: deps.provider,
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
    providerReq: {
      name: deps.cfg.providerName,
      baseURL: deps.cfg.baseURL,
      apiKey: deps.cfg.apiKey,
      model: deps.cfg.model,
    },
    system: SYSTEM_PROMPT,
    maxIterations: deps.cfg.maxIterations,
    toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
  })
  process.stdout.write('\n')
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  registerBuiltinCommands()
  const deps = makeDeps(cfg)

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
  render(React.createElement(TuiApp, { deps }), { exitOnCtrlC: false })
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
