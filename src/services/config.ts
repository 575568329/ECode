/**
 * Config 最小切片（M1）。
 *
 * 详设 §4.1 + 解析决策 1。M1 只读单 provider 的 baseURL/apiKey/model + maxIterations。
 * 优先级（高→低）：进程环境变量（含 .env 加载，dev 内部机制）> config 文件 > 默认值。
 *
 * 用户体验（终端用户只感知 config.json）：
 *   - 首次启动检测 ~/.ecode/config.json 不存在 → 自动生成带注释的模板（apiKey 留空）
 *   - 提示用户编辑 config.json 填写 apiKey 后重启
 *   - 创建失败才报错；错误信息只引导编辑 config，不暴露 .env/环境变量（dev 内部）
 *
 * 完整 Config（多 provider/采样参数/交互式向导）留 M4。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseJsonc } from 'jsonc-parser'
import dotenv from 'dotenv'

export interface M1Config {
  /** 配置实例名（对应 config.providers 的 key，用作 Provider client 缓存键） */
  providerName: string
  /** 协议类型（providers[name].type，喂 registry.getByType） */
  type: string
  model: string
  baseURL: string
  apiKey: string
  maxIterations: number
}

interface ProviderCfg {
  type?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
}

interface ConfigFile {
  default?: { provider?: string; model?: string }
  providers?: Record<string, ProviderCfg>
  maxIterations?: number
}

export interface LoadConfigOpts {
  /** 自定义 config 路径（默认 ~/.ecode/config.json） */
  configPath?: string
  /** cwd（用于找 .env，默认 process.cwd()） */
  cwd?: string
  /** 是否加载 .env（默认 true，测试可关） */
  loadDotenv?: boolean
}

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.ecode', 'config.json')
}

/** 首次运行自动生成的模板（JSONC，带注释引导；apiKey 留空让用户填）。 */
const CONFIG_TEMPLATE = `{
  // ECode 配置（首次启动自动生成）。编辑后重启生效。
  // 启动默认选中的 供应商+模型
  "default": { "provider": "astron", "model": "glm-5.2" },

  // 供应商：key=自定义名字，value 含协议类型/端点/密钥/可选模型
  "providers": {
    "astron": {
      "type": "anthropic",                                  // 协议：anthropic | openai
      "baseURL": "https://open.bigmodel.cn/api/anthropic",  // 智谱 Anthropic 兼容端点（跑 GLM）
      "apiKey": "",                                         // ← 请填写你的 API Key（必填）
      "models": ["glm-5.2"]
    }
    // 多供应商示例（按需启用）：
    // "deepseek": {
    //   "type": "openai",
    //   "baseURL": "https://api.deepseek.com/v1",
    //   "apiKey": "",                                       // ← 请填写
    //   "models": ["deepseek-v4-pro"]
    // }
  },

  "maxIterations": 50
}
`

/** 自动生成模板 config（含目录创建）。创建失败抛错。 */
function writeDefaultConfig(cfgPath: string): void {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, CONFIG_TEMPLATE, 'utf8')
}

export function loadConfig(opts: LoadConfigOpts = {}): M1Config {
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
    // config 不存在：首次运行，自动生成模板（除非创建失败）
    try {
      writeDefaultConfig(cfgPath)
      created = true
    } catch (e) {
      throw new Error(
        `[CONFIG_CREATE_FAILED] 无法创建配置文件 ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    // 新建的模板本次按空解析（靠 env 覆盖，或校验失败提示用户编辑）
    file = {}
  }

  // 选 provider：default.provider 优先，否则第一个，否则 'astron'（默认）
  const providerName = file.default?.provider ?? Object.keys(file.providers ?? {})[0] ?? 'astron'
  const providerCfg = file.providers?.[providerName] ?? {}

  // 优先级：环境变量（含 dev .env）> config > 默认
  const type = providerCfg.type ?? process.env.ECODE_TYPE ?? 'anthropic'
  const model = process.env.ECODE_MODEL ?? file.default?.model ?? providerCfg.models?.[0]
  const baseURL = process.env.ECODE_BASE_URL ?? providerCfg.baseURL
  const apiKey = process.env.ANTHROPIC_API_KEY ?? providerCfg.apiKey
  const maxIterations = file.maxIterations ?? 50

  // 首次生成模板：若 env 没补全关键字段，提示用户编辑 config 后重启
  if (created) {
    if (!apiKey || !baseURL || !model) {
      throw new Error(
        `[CONFIG_INIT] 首次运行：已为你生成配置模板 ${cfgPath}。请编辑填写 apiKey（及 baseURL/model）后重启。`,
      )
    }
    // env 补全了（dev .env）——继续跑，但提示用户模板已生成可按需编辑
    process.stderr.write(`[CONFIG] 已生成配置模板 ${cfgPath}（本次用环境变量运行，可按需编辑模板）\n`)
  }

  // 校验：错误信息只引导编辑 config（不暴露 .env/环境变量给终端用户）
  if (!apiKey) {
    throw new Error(`[NO_API_KEY] 缺少 API Key。请编辑 ${cfgPath} 的 providers.${providerName}.apiKey 填写你的 Key`)
  }
  if (!baseURL) {
    throw new Error(`[NO_BASE_URL] 缺少 baseURL。请编辑 ${cfgPath} 的 providers.${providerName}.baseURL`)
  }
  if (!model) {
    throw new Error(`[NO_MODEL] 缺少 model。请编辑 ${cfgPath} 的 default.model 或 providers.${providerName}.models`)
  }

  return { providerName, type, model, baseURL, apiKey, maxIterations }
}
