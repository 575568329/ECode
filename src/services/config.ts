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
import { parse as parseJsonc } from 'jsonc-parser'
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
}

export interface Config {
  providers: Record<string, ProviderCfg> // 多 provider map
  current: { name: string; model: string } // 当前激活（/model 改这个）
  maxIterations: number
  bashMaxOutputBytes: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** 磁盘格式（jsonc-parser 解析，允许注释） */
interface ConfigFile {
  default?: { provider?: string; model?: string }
  providers?: Record<string, Partial<ProviderCfg>>
  maxIterations?: number
  bashMaxOutputBytes?: number
  logLevel?: string
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

  "maxIterations": 50,        // Agent 循环最大轮数
  "bashMaxOutputBytes": 30720 // bash 输出截断阈值（30KB 头尾中截）
  // "logLevel": "info"       // 日志级别：debug | info | warn | error
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
    } catch {
      // .env 读失败静默
    }
  }

  const cfgPath = opts.configPath ?? defaultConfigPath()
  let file: ConfigFile = {}
  let created = false
  try {
    file = parseJsonc(fs.readFileSync(cfgPath, 'utf8')) as ConfigFile
  } catch {
    // config 不存在 → 生成完整模板（D10：给编辑起点，但不当判断依据）
    try {
      writeDefaultConfig(cfgPath)
      created = true
    } catch (e) {
      throw new Error(
        `[CONFIG_CREATE_FAILED] 无法创建配置文件 ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    file = {}
  }

  // 选 provider：default.provider 优先，否则第一个，否则 'astron'（默认）
  const providersIn = file.providers ?? {}
  const providerName = file.default?.provider ?? Object.keys(providersIn)[0] ?? 'astron'
  const rawCfg = providersIn[providerName] ?? {}

  // 优先级：环境变量（含 dev .env）> config > 默认
  const type = (rawCfg.type ?? process.env.ECODE_TYPE ?? 'anthropic') as ProviderCfg['type']
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
    maxIterations: file.maxIterations ?? 50,
    bashMaxOutputBytes: file.bashMaxOutputBytes ?? 30720,
    logLevel: (file.logLevel as Config['logLevel']) ?? 'info',
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
  }
}

/** /setup 向导收集的值（writeWizardConfig 用） */
export interface WizardValues {
  type: 'anthropic' | 'openai'
  baseURL: string
  apiKey: string
  models: string // 逗号分隔（写时 split + trim → string[]）
  thinking: ThinkingLevel
}

/**
 * 向导值 → 写完整 config.json（JSONC 含注释引导；§10.1 步骤 6）。
 * provider name 固定 'default'（Wizard 不问 name；用户可编辑改名）。
 * 文件权限 600（Windows chmod 弱化尽力，Linux/macOS 生效）。
 */
export function writeWizardConfig(values: WizardValues, opts: { configPath?: string } = {}): void {
  const cfgPath = opts.configPath ?? defaultConfigPath()
  const models = values.models.split(',').map((s) => s.trim()).filter(Boolean)
  const content = `{
  // ECode 配置（/setup 向导生成）。编辑后重启生效，或运行时 /model 切换、/setup 重配。
  "default": { "provider": "default", "model": "${models[0] ?? ''}" },

  "providers": {
    "default": {
      "type": "${values.type}",                                  // 协议：anthropic | openai
      "baseURL": "${values.baseURL}",                            // 端点
      "apiKey": "${values.apiKey}",                              // API Key
      "models": ${JSON.stringify(models)},                       // 可用模型（/model 列这些）
      "thinking": "${values.thinking}",                          // 思考强度：off | low | medium | high
      "maxTokens": 8192                                          // 单次最大输出 token
    }
  },

  "maxIterations": 50,        // Agent 循环最大轮数
  "bashMaxOutputBytes": 30720 // bash 输出截断阈值（30KB 头尾中截）
}
`
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, content, { mode: 0o600 })
}

/** 配置无效态空壳（P0-4）：cli catch loadConfig 失败时构造，TuiApp 仍能渲染（banner + /setup 可用）。 */
export function emptyShellConfig(): Config {
  return {
    providers: {},
    current: { name: '', model: '' },
    maxIterations: 50,
    bashMaxOutputBytes: 30720,
    logLevel: 'info',
  }
}
