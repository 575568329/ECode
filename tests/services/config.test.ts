import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfig, buildProviderReq } from '../../src/services/config.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cfg-'))
const cfgPath = path.join(tmp, 'config.json')

function writeConfig(text: string) {
  fs.writeFileSync(cfgPath, text)
}

const baseEnv = { ...process.env }
beforeEach(() => {
  process.env = { ...baseEnv }
})
afterEach(() => {
  process.env = { ...baseEnv }
})

describe('loadConfig', () => {
  it('读合法 config → Config（providers map + current）', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'astron', model: 'glm-5.2' },
        providers: {
          astron: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk-c', models: ['glm-5.2'] },
        },
        maxIterations: 30,
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.current.name).toBe('astron')
    expect(cfg.current.model).toBe('glm-5.2')
    expect(cfg.providers.astron.type).toBe('anthropic')
    expect(cfg.providers.astron.baseURL).toBe('http://x')
    expect(cfg.providers.astron.apiKey).toBe('sk-c')
    expect(cfg.maxIterations).toBe(30)
  })

  it('环境变量覆盖 apiKey/baseURL/model（env > config）', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'astron', model: 'old' },
        providers: { astron: { type: 'anthropic', baseURL: 'http://c', apiKey: 'sk-c', models: ['old'] } },
      }),
    )
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    process.env.ECODE_BASE_URL = 'http://env'
    process.env.ECODE_MODEL = 'glm-env'
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.providers.astron.apiKey).toBe('sk-env')
    expect(cfg.providers.astron.baseURL).toBe('http://env')
    expect(cfg.current.model).toBe('glm-env')
  })

  it('maxIterations 缺省 → 50', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.maxIterations).toBe(50)
  })

  it('config 不存在 + 无 env → 自动新建模板 + 抛配置无效（D10，不再 CONFIG_INIT）', () => {
    const fresh = path.join(tmp, `init-${Date.now()}`, 'config.json')
    // D10：统一走有效性校验，config 不存在也生成模板，但抛 [NO_API_KEY] 引导 /setup
    expect(() => loadConfig({ configPath: fresh, loadDotenv: false })).toThrow(/api[_ ]?key|密钥|NO_API_KEY/i)
    expect(fs.existsSync(fresh)).toBe(true) // 自动新建了模板
  })

  it('config 不存在 + env 补全（dev .env）→ 自动新建 + 用 env 运行', () => {
    const fresh = path.join(tmp, `env-${Date.now()}`, 'config.json')
    process.env.ECODE_BASE_URL = 'http://env'
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    process.env.ECODE_MODEL = 'glm-env'
    const cfg = loadConfig({ configPath: fresh, loadDotenv: false })
    expect(cfg.providers.astron.baseURL).toBe('http://env')
    expect(cfg.providers.astron.apiKey).toBe('sk-env')
    expect(cfg.current.model).toBe('glm-env')
    expect(cfg.current.name).toBe('astron')
    expect(cfg.providers.astron.type).toBe('anthropic')
    expect(fs.existsSync(fresh)).toBe(true) // 自动新建了
  })

  it('缺 apiKey（且无环境变量）→ 抛清晰错误', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', models: ['m'] } },
      }),
    )
    expect(() => loadConfig({ configPath: cfgPath, loadDotenv: false })).toThrow(/api[_ ]?key|密钥/i)
  })

  it('JSONC 带注释能解析', () => {
    writeConfig(`{
      // 这是注释
      "default": { "provider": "a", "model": "m" },
      "providers": { "a": { "type": "anthropic", "baseURL": "http://x", "apiKey": "sk", "models": ["m"] } }
    }`)
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.providers.a.apiKey).toBe('sk')
  })

  it('default.model 缺省时取 providers.models[0]', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['first', 'second'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.current.model).toBe('first')
  })

  it('thinking 枚举 + maxTokens 解析（D9）', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a', model: 'm' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'], thinking: 'high', maxTokens: 4096 } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.providers.a.thinking).toBe('high')
    expect(cfg.providers.a.maxTokens).toBe(4096)
  })

  it('bashMaxOutputBytes / logLevel 缺省值', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.bashMaxOutputBytes).toBe(30720)
    expect(cfg.logLevel).toBe('info')
  })

  it('多 provider：providers map 含全部', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'astron', model: 'glm-5.2' },
        providers: {
          astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'sk-a', models: ['glm-5.2'] },
          deepseek: { type: 'openai', baseURL: 'http://d', apiKey: 'sk-d', models: ['ds-v4'] },
        },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(Object.keys(cfg.providers)).toEqual(expect.arrayContaining(['astron', 'deepseek']))
    expect(cfg.providers.deepseek.type).toBe('openai')
  })
})

describe('buildProviderReq', () => {
  it('从 Config 派生 ProviderReq（含采样参数）', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a', model: 'm' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'], thinking: 'medium', maxTokens: 8192, temperature: 0.7 } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    const req = buildProviderReq(cfg)
    expect(req.name).toBe('a')
    expect(req.baseURL).toBe('http://x')
    expect(req.apiKey).toBe('sk')
    expect(req.model).toBe('m')
    expect(req.thinking).toBe('medium')
    expect(req.maxTokens).toBe(8192)
    expect(req.temperature).toBe(0.7)
  })

  it('采样参数缺省时不带 undefined 字段', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a', model: 'm' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    const req = buildProviderReq(cfg)
    expect(req.thinking).toBeUndefined()
    expect(req.temperature).toBeUndefined()
  })
})
