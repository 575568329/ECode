/**
 * M1 真实 LLM 烟测脚本（单次 runLoop，不走 readline REPL）。
 * 用法：npx tsx scripts/smoke.ts
 *
 * 验证 9 项清单（核心 ①②③④⑤⑥⑧）：
 *   ① stop_reason 取值  ② stream 事件  ③ 工具调用 JSON 分片  ④ usage
 *   ⑤ JSON Schema 支持  ⑥ system 参数  ⑦ ESM 依赖  ⑧ stream-tool 透传
 */
import { loadConfig } from '../src/services/config.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { LLMProviderRegistryImpl } from '../src/providers/registry.js'
import { ToolRegistryImpl } from '../src/tools/registry.js'
import { readFileTool } from '../src/tools/builtin/read_file.js'
import { bashTool } from '../src/tools/builtin/bash.js'
import { ConsoleLogger } from '../src/services/logger.js'
import { NoopHistoryStore } from '../src/services/history.js'
import { runLoop } from '../src/core/loop.js'
import type { Message } from '../src/core/types.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  // 不打印 apiKey
  console.log(`[smoke] model=${cfg.model} provider=${cfg.providerName} type=${cfg.type} baseURL=${cfg.baseURL}`)

  const providerReg = new LLMProviderRegistryImpl()
  providerReg.register(new AnthropicProvider())
  const toolReg = new ToolRegistryImpl()
  toolReg.register(readFileTool)
  toolReg.register(bashTool)

  const messages: Message[] = []
  const t0 = Date.now()

  await runLoop(messages, '读 package.json 并告诉我版本号和项目名', {
    provider: providerReg.getByType(cfg.type),
    tools: toolReg,
    logger: new ConsoleLogger(),
    history: new NoopHistoryStore(),
    callbacks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: (name) => process.stdout.write(`\n[tool start] ${name}\n`),
      onToolResult: (name, r) =>
        process.stdout.write(`[tool result] ${name} ${r.is_error ? '✗' : '✓'} (${r.content.length} 字节)\n`),
      onUsage: (inp, out) => process.stdout.write(`\n[usage] in=${inp} out=${out}\n`),
      onWarn: (m) => process.stdout.write(`\n[warn] ${m}\n`),
    },
    providerReq: { name: cfg.providerName, baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model },
    system: `你是 ECode，一个终端 Agent CLI。当前工作目录：${process.cwd()}。回复用中文。`,
    maxIterations: cfg.maxIterations,
    toolCtx: { cwd: process.cwd(), signal: new AbortController().signal },
  })

  console.log(`\n\n[smoke] 耗时 ${Date.now() - t0}ms，共 ${messages.length} 条消息`)
  console.log('=== messages 演进（结构）===')
  for (const m of messages) {
    const kinds = m.content.map((b) => b.type).join(',')
    console.log(`  ${m.role}: ${kinds}`)
  }
}

main().catch((e) => {
  console.error('[smoke failed]', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
