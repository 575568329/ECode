/**
 * Config 完整版（M4 P0-1）。
 *
 * 详设 §4 + M4 §4。providers map + current + per-provider 采样参数。
 * 优先级（高→低）：进程环境变量（含 .env 加载，dev 内部机制）> config 文件 > 默认值。
 *
 * 数据分层（D12）：config.json 用户级（~/.ecode/），重要数据防误删。
 * 配置有效性判断（D10）：不看「首次运行」，只看能否拿到有效 provider
 *   （apiKey+baseURL+model 齐）。无效 → cli 进 REPL + banner 提示 /setup。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseJsonc, modify, applyEdits, type FormattingOptions } from 'jsonc-parser'
import dotenv from 'dotenv'
import type { ProviderReq, ThinkingLevel } from '../providers/interface.js'

/** 单个供应商配置（export：buildProviderReq / Wizard / /model 都要用） */
export interface ProviderCfg {
  type: 'anthropic' | 'openai'
  baseURL: string
  apiKey: string
  models: string[]
  temperature?: number
  topP?: number
  maxTokens?: number
  thinking?: ThinkingLevel
  /** 上下文窗口覆盖（escape hatch；不配则 models.dev 自动探测，M5 §5） */
  contextWindow?: number  /** 定价覆盖（M8 债 #6）：{ "<model>": { input, output, cacheRead?, cacheWrite? } }，¥/Mtok——优先于内置表与 models.dev 同步值 */
  pricing?: Record<string, import('./pricing.js').ModelPricing>

}

export interface Config {
  providers: Record<string, ProviderCfg> // 多 provider map
  current: { name: string; model: string } // 当前激活（/model 改这个）
  maxIterations: number
  bashMaxOutputBytes: number
  /** 指令/记忆注入单级上限 KB（M8：ECODE.md/CLAUDE.md/MEMORY.md 各级截断阈值，默认 32） */
  maxInstructionsKB?: number
  /** web_fetch 回喂内容上限 KB（默认 30，头尾中截） */
  webFetchMaxKB?: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** MCP servers（M6；用户级配置，项目级 .mcp.json 在 mcp/config.ts 单独合并） */
  mcpServers?: Record<string, import('./mcp/config.js').McpServerConfig>
  /** hooks 原始声明（M7 H1 源 1；AJV 过滤在 hooks/validate.ts，非法项跳过 + warn 不炸启动） */
  hooks?: unknown
}

/** 默认值（P2-1：集中常量，免多处裸魔法值散落；CONFIG_TEMPLATE/writeWizardConfig 是生成给用户的 config.json 字面量） */
const DEFAULT_MAX_ITERATIONS = 50
const DEFAULT_BASH_MAX_BYTES = 30720
const DEFAULT_LOG_LEVEL: Config['logLevel'] = 'info'

/** 磁盘格式（jsonc-parser 解析，允许注释） */
interface ConfigFile {
  default?: { provider?: string; model?: string }
  providers?: Record<string, Partial<ProviderCfg>>
  maxIterations?: number
  bashMaxOutputBytes?: number
  maxInstructionsKB?: number
  webFetchMaxKB?: number
  logLevel?: string
  mcpServers?: Record<string, import('./mcp/config.js').McpServerConfig>
  /** hooks 原始数组（jsonc 透传；过滤在 hooks/validate.ts） */
  hooks?: unknown
}

export interface LoadConfigOpts {
  /** 自定义 config 路径（默认 ~/.ecode/config.json） */
  configPath?: string
  /** cwd（用于找 .env，默认 process.cwd()） */
  cwd?: string
  /** 是否加载 .env（默认 true，测试可关） */
  loadDotenv?: boolean
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.ecode', 'config.json')
}

/** 首次运行自动生成的模板（JSONC，带注释引导；§4.4）。 */
const CONFIG_TEMPLATE = `{
  // ECode 配置（首次启动自动生成）。编辑后重启生效，或运行时 /model 切换、/setup 重配。
  // 启动默认选中的 供应商+模型
  "default": { "provider": "astron", "model": "glm-5.2" },

  // 供应商：key=自定义名字，value 含协议/端点/密钥/模型/采样参数
  "providers": {
    "astron": {
      "type": "anthropic",                                  // 协议：anthropic | openai
      "baseURL": "https://open.bigmodel.cn/api/anthropic",  // 端点（示例，按需改）
      "apiKey": "",                                         // ← 必填
      "models": ["glm-5.2"],                                // 可用模型（/model 列这些；可多个）
      "thinking": "medium",                                 // 思考强度：off | low | medium | high
      "maxTokens": 8192                                     // 单次最大输出 token
      // "temperature": 0.7,                                // 采样温度（可选，per-provider）
      // "topP": 0.95                                       // nucleus sampling（可选）
    }
    // 多供应商示例（按需启用）：
    // "deepseek": {
    //   "type": "openai",
    //   "baseURL": "https://api.deepseek.com/v1",
    //   "apiKey": "",
    //   "models": ["deepseek-v4-pro"],
    //   "thinking": "off"
    // }
  },

  // MCP 外部工具（可选）：加进来自动注册工具，/mcp 查看。项目级配置放项目根 .mcp.json（团队共享，首用弹批准）。
  // "mcpServers": {
  //   "filesystem": {                      // 名字自定义（工具名 = mcp__名字__工具名）
  //     "type": "stdio",                   // stdio（拉起本地子进程）| http（连远程）
  //     "command": "npx",                  // stdio 必填
  //     "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  //     "lifecycle": "lazy",               // 默认 lazy（首次调用才连接）；空闲 idleTimeout 分钟（默认 10）自动断开
  //     "timeout": 30000,                  // 单次调用超时 ms（默认 30s）
  //     "env": { "TOKEN": "\${MY_TOKEN}" }  // secret 用环境变量占位符，不落明文（缺失则跳过该 server）
  //   },
  //   "my-http": {
  //     "type": "http",                    // http 必填 url；headers 同样支持 \${ENV_VAR}
  //     "url": "https://mcp.example.com/mcp",
  //     "headers": { "Authorization": "Bearer \${MY_KEY}" }
  //   }
  // },

  "maxIterations": 50,        // Agent 循环最大轮数
  "bashMaxOutputBytes": 30720, // bash 输出截断阈值（30KB 头尾中截）
  // "logLevel": "info",       // 日志级别：debug | info | warn | error
  // "maxInstructionsKB": 32,  // 指令/记忆注入单级上限 KB（ECODE.md/CLAUDE.md/MEMORY.md）
  // "webFetchMaxKB": 30,      // web_fetch 回喂内容上限 KB（头尾中截）
  // "hooks": [                // 事件 hook（M7）：command 子进程，stdin 收事件 JSON
  //   { "event": "PostToolUse", "matcher": "edit_file|write_file",
  //     "handler": { "kind": "command", "command": "prettier ." } }
  // ]
}
`

/** 自动生成模板 config（含目录创建）。创建失败抛错。 */
function writeDefaultConfig(cfgPath: string): void {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, CONFIG_TEMPLATE, 'utf8')
}

export function loadConfig(opts: LoadConfigOpts = {}): Config {
  const cwd = opts.cwd ?? process.cwd()

  // .env 加载（dev 内部，不暴露给用户；不存在则静默）
  if (opts.loadDotenv !== false) {
    try {
      dotenv.config({ path: path.join(cwd, '.env') })
    } catch (e) {
      // P2-2：不静默吞异常（AGENTS 1.2），stderr 提示（.env 失败不阻断，配置仍从文件读）
      process.stderr.write(`[CONFIG] .env 加载失败（忽略）：${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  const cfgPath = opts.configPath ?? defaultConfigPath()
  let file: ConfigFile = {}
  let created = false
  try {
    file = parseJsonc(fs.readFileSync(cfgPath, 'utf8')) as ConfigFile
  } catch (e) {
    // P0-1：仅文件不存在（ENOENT）才生成模板；解析失败（用户写坏 JSON）绝不覆盖——否则丢密钥/多 provider 配置
    if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw new Error(
        `[CONFIG_PARSE_FAILED] 配置文件解析失败 ${cfgPath}：${e instanceof Error ? e.message : String(e)}（请手动修复，或删除该文件后重启以生成模板）`,
      )
    }
    try {
      writeDefaultConfig(cfgPath)
      created = true
    } catch (ce) {
      throw new Error(
        `[CONFIG_CREATE_FAILED] 无法创建配置文件 ${cfgPath}: ${ce instanceof Error ? ce.message : String(ce)}`,
      )
    }
    file = {}
  }

  // 选 provider：default.provider 优先，否则第一个，否则 'astron'（默认）
  const providersIn = file.providers ?? {}
  const providerName = file.default?.provider ?? Object.keys(providersIn)[0] ?? 'astron'
  const rawCfg = providersIn[providerName] ?? {}

  // 优先级：环境变量（含 dev .env）> config > 默认
  // P1-12：统一 env 优先（与 baseURL/apiKey/model 一致），否则 ECODE_TYPE 切 protocol 无效
  const type = (process.env.ECODE_TYPE ?? rawCfg.type ?? 'anthropic') as ProviderCfg['type']
  const baseURL = process.env.ECODE_BASE_URL ?? rawCfg.baseURL
  const apiKey = process.env.ANTHROPIC_API_KEY ?? rawCfg.apiKey
  const model = process.env.ECODE_MODEL ?? file.default?.model ?? rawCfg.models?.[0]

  // 首次生成模板 + env 补全 → 提示可编辑（继续跑）
  if (created && apiKey && baseURL && model) {
    process.stderr.write(`[CONFIG] 已生成配置模板 ${cfgPath}（本次用环境变量运行，可按需编辑模板）\n`)
  }

  // D10：统一有效性校验（不分首次/非首次；错误信息引导 /setup 或编辑 config）
  if (!apiKey) {
    throw new Error(`[NO_API_KEY] 缺少 API Key。请编辑 ${cfgPath} 的 providers.${providerName}.apiKey，或运行 /setup`)
  }
  if (!baseURL) {
    throw new Error(`[NO_BASE_URL] 缺少 baseURL。请编辑 ${cfgPath} 的 providers.${providerName}.baseURL，或运行 /setup`)
  }
  if (!model) {
    throw new Error(`[NO_MODEL] 缺少 model。请编辑 ${cfgPath} 的 default.model，或运行 /setup`)
  }

  // 构造 providers map（磁盘 Partial → 完整 ProviderCfg）
  const providers: Record<string, ProviderCfg> = {}
  for (const [name, cfg] of Object.entries(providersIn)) {
    providers[name] = {
      type: (cfg.type ?? 'anthropic') as ProviderCfg['type'],
      baseURL: cfg.baseURL ?? '',
      apiKey: cfg.apiKey ?? '',
      models: cfg.models ?? [],
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
      ...(cfg.thinking !== undefined ? { thinking: cfg.thinking as ThinkingLevel } : {}),
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
    }
  }
  // env 覆盖当前 provider 关键字段（dev 场景：.env 注入）
  providers[providerName] = {
    ...providers[providerName],
    type,
    baseURL,
    apiKey,
    models: rawCfg.models?.length ? rawCfg.models : [model],
  }

  return {
    providers,
    current: { name: providerName, model },
    maxIterations: file.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    bashMaxOutputBytes: file.bashMaxOutputBytes ?? DEFAULT_BASH_MAX_BYTES,
    ...(file.maxInstructionsKB !== undefined ? { maxInstructionsKB: file.maxInstructionsKB } : {}),
    ...(file.webFetchMaxKB !== undefined ? { webFetchMaxKB: file.webFetchMaxKB } : {}),
    logLevel: (file.logLevel as Config['logLevel']) ?? DEFAULT_LOG_LEVEL,
    ...(file.mcpServers !== undefined ? { mcpServers: file.mcpServers } : {}),
  ...(file.hooks !== undefined ? { hooks: file.hooks } : {}),
  }
}

/** 从 Config 派生 ProviderReq（cli argv + TuiApp submit 共用，避免漂移 P1-3） */
export function buildProviderReq(config: Config): ProviderReq {
  const cfg = config.providers[config.current.name]
  return {
    name: config.current.name,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: config.current.model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.topP !== undefined ? { topP: cfg.topP } : {}),
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
    ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
    ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
  }
}

/** /setup 向导收集的值（writeWizardConfig 用） */
export interface WizardValues {
  /** 操作模式：add=新增 provider / edit=编辑现有。首次（无 config）走 add */
  mode: 'add' | 'edit'
  /** 目标 provider 名（add 时用户输入；edit 时为现有名） */
  providerName: string
  type: 'anthropic' | 'openai'
  baseURL: string
  apiKey: string
  models: string // 逗号分隔（写时 split + trim → string[]）
  thinking: ThinkingLevel
}

/** 向导值的 provider 对象（modify 写入用；字段顺序与 CONFIG_TEMPLATE 一致） */
function wizardProviderObject(values: WizardValues): Record<string, unknown> {
  const models = values.models.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    type: values.type,
    baseURL: values.baseURL,
    apiKey: values.apiKey,
    models,
    thinking: values.thinking,
    maxTokens: 8192,
  }
}

/**
 * 向导值 → 合并进 config.json（增量改单个 provider；§10.1 步骤 6）。
 *
 * 用 jsonc-parser modify/applyEdits 基于文本偏移编辑，**保留所有注释和未触及的 provider**
 * （区别于旧版整文件覆写——P1-5 修复）。
 *   - mode=add：新 provider 插入 providers map + default 自动切到新 provider（立即生效）
 *   - mode=edit：覆盖现有 provider 字段，不动 default（用户可能已 /model 切过）
 *   - config 不存在：用 CONFIG_TEMPLATE 作底（mode 强制 add）
 *
 * 文件权限 600（Windows chmod 弱化尽力，Linux/macOS 生效）。
 */
export function writeWizardConfig(values: WizardValues, opts: { configPath?: string } = {}): void {
  // P1-4：写前校验空值——防误按回车用空值覆盖有效 config
  if (!values.providerName.trim()) throw new Error('[SETUP_INCOMPLETE] provider 名不能为空')
  if (!values.baseURL.trim()) throw new Error('[SETUP_INCOMPLETE] baseURL 不能为空')
  if (!values.apiKey.trim()) throw new Error('[SETUP_INCOMPLETE] apiKey 不能为空')
  if (!values.models.trim()) throw new Error('[SETUP_INCOMPLETE] model 不能为空')

  const cfgPath = opts.configPath ?? defaultConfigPath()
  const fmt: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' }
  const models = values.models.split(',').map((s) => s.trim()).filter(Boolean)

  // 读现有文本（不存在 → CONFIG_TEMPLATE 作底，强制 add 语义）
  let text: string
  let fileExists = true
  try {
    text = fs.readFileSync(cfgPath, 'utf8')
  } catch {
    text = CONFIG_TEMPLATE
    fileExists = false
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  // P1-5：写前备份现有 config（modify 算错可从 .bak 恢复）
  if (fileExists) {
    try {
      fs.copyFileSync(cfgPath, cfgPath + '.bak')
    } catch {
      // 备份失败不阻断写入（只读 fs 等极端情况，尽力）
    }
  }

  // 增量编辑：modify 计算最小文本编辑（保留注释/未触及内容）→ applyEdits 应用
  // 关键：每次 modify 基于上一次 applyEdits 的结果文本（不能基于原 text，否则多次编辑偏移错位）
  let result = applyEdits(text, modify(text, ['providers', values.providerName], wizardProviderObject(values), { formattingOptions: fmt }))
  // 新增模式：default 自动切到新 provider（立即生效）；编辑模式不动 default
  if (values.mode === 'add' || !fileExists) {
    result = applyEdits(result, modify(result, ['default'], { provider: values.providerName, model: models[0] ?? '' }, { formattingOptions: fmt }))
  }
  fs.writeFileSync(cfgPath, result, { mode: 0o600 })
}

/** 配置无效态空壳（P0-4）：cli catch loadConfig 失败时构造，TuiApp 仍能渲染（banner + /setup 可用）。 */
export function emptyShellConfig(): Config {
  return {
    providers: {},
    current: { name: '', model: '' },
    maxIterations: DEFAULT_MAX_ITERATIONS,
    bashMaxOutputBytes: DEFAULT_BASH_MAX_BYTES,
    logLevel: DEFAULT_LOG_LEVEL,
  }
}
