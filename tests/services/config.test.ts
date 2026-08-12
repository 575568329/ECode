import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfig } from '../../src/services/config.js'

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
  it('读合法 config → M1Config（单 provider）', () => {
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
    expect(cfg.providerName).toBe('astron')
    expect(cfg.type).toBe('anthropic')
    expect(cfg.model).toBe('glm-5.2')
    expect(cfg.baseURL).toBe('http://x')
    expect(cfg.apiKey).toBe('sk-c')
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
    expect(cfg.apiKey).toBe('sk-env')
    expect(cfg.baseURL).toBe('http://env')
    expect(cfg.model).toBe('glm-env')
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

  it('config 不存在 + 无 env → 自动新建模板 + 提示编辑（CONFIG_INIT）', () => {
    const fresh = path.join(tmp, `init-${Date.now()}`, 'config.json')
    expect(() => loadConfig({ configPath: fresh, loadDotenv: false })).toThrow(/首次|编辑|填写|CONFIG_INIT/i)
    expect(fs.existsSync(fresh)).toBe(true) // 自动新建了模板
  })

  it('config 不存在 + env 补全（dev .env）→ 自动新建 + 用 env 运行', () => {
    const fresh = path.join(tmp, `env-${Date.now()}`, 'config.json')
    process.env.ECODE_BASE_URL = 'http://env'
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    process.env.ECODE_MODEL = 'glm-env'
    const cfg = loadConfig({ configPath: fresh, loadDotenv: false })
    expect(cfg.baseURL).toBe('http://env')
    expect(cfg.apiKey).toBe('sk-env')
    expect(cfg.model).toBe('glm-env')
    expect(cfg.providerName).toBe('astron')
    expect(cfg.type).toBe('anthropic')
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
    expect(cfg.apiKey).toBe('sk')
  })

  it('default.model 缺省时取 providers.models[0]', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['first', 'second'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.model).toBe('first')
  })
})
