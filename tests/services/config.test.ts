import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfig, buildProviderReq, writeWizardConfig, emptyShellConfig, loadDotenvMap } from '../../src/services/config.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-cfg-'))
const cfgPath = path.join(tmp, 'config.json')

function writeConfig(text: string) {
  fs.writeFileSync(cfgPath, text)
}

// F-12（批2a §10.4）：baseEnv 剔除与 loadConfig 读取面（ECODE_* / ANTHROPIC_API_KEY）对齐的变量——
// ECode 会话内跑测试时父进程注入这些 env，不剔除则 11 用例会内外结果不同（剔多会失真）。
// 仅剔除读取面命中的键，保留其他 env 通道活（防退化：env 覆盖 config 的用例仍真实生效）。
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) => v !== undefined && !k.toUpperCase().startsWith('ECODE_') && k !== 'ANTHROPIC_API_KEY',
  ),
) as NodeJS.ProcessEnv
beforeEach(() => {
  process.env = { ...baseEnv }
})
afterEach(() => {
  process.env = { ...baseEnv }
})

describe('writeWizardConfig', () => {
  it('首次（无 config）→ 用模板作底 + provider name=default + default 自动切', () => {
    // 无文件 → CONFIG_TEMPLATE 作底，mode 不影响（!fileExists 强制 add 语义）
    writeWizardConfig(
      { mode: 'add', providerName: 'default', type: 'anthropic', baseURL: 'http://x', apiKey: 'sk-c', models: 'glm-5.2, glm-4', thinking: 'medium' },
      { configPath: cfgPath },
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.current).toEqual({ name: 'default', model: 'glm-5.2' })
    expect(cfg.providers.default.type).toBe('anthropic')
    expect(cfg.providers.default.baseURL).toBe('http://x')
    expect(cfg.providers.default.apiKey).toBe('sk-c')
    expect(cfg.providers.default.models).toEqual(['glm-5.2', 'glm-4'])
    expect(cfg.providers.default.thinking).toBe('medium')
  })

  it('新增 provider（mode=add）→ 保留现有 provider + default 自动切到新 provider', () => {
    // 先有一个 astron provider
    writeConfig(JSON.stringify({
      default: { provider: 'astron', model: 'glm-5.2' },
      providers: { astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'sk-a', models: ['glm-5.2'] } },
    }))
    writeWizardConfig(
      { mode: 'add', providerName: 'deepseek', type: 'openai', baseURL: 'http://d', apiKey: 'sk-d', models: 'deepseek-v4', thinking: 'off' },
      { configPath: cfgPath },
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    // 关键：astron 保留
    expect(cfg.providers.astron).toBeDefined()
    expect(cfg.providers.astron.apiKey).toBe('sk-a')
    // 新增的 deepseek
    expect(cfg.providers.deepseek.type).toBe('openai')
    expect(cfg.providers.deepseek.apiKey).toBe('sk-d')
    // default 自动切到新 provider
    expect(cfg.current).toEqual({ name: 'deepseek', model: 'deepseek-v4' })
  })

  it('编辑现有 provider（mode=edit）→ 覆盖该 provider 字段 + 不动 default + 其他保留', () => {
    writeConfig(JSON.stringify({
      default: { provider: 'astron', model: 'glm-5.2' },
      providers: {
        astron: { type: 'anthropic', baseURL: 'http://a', apiKey: 'sk-old', models: ['glm-5.2'] },
        deepseek: { type: 'openai', baseURL: 'http://d', apiKey: 'sk-d', models: ['deepseek-v4'] },
      },
    }))
    writeWizardConfig(
      { mode: 'edit', providerName: 'astron', type: 'anthropic', baseURL: 'http://a-new', apiKey: 'sk-new', models: 'glm-5.2, glm-4', thinking: 'high' },
      { configPath: cfgPath },
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    // astron 被改
    expect(cfg.providers.astron.baseURL).toBe('http://a-new')
    expect(cfg.providers.astron.apiKey).toBe('sk-new')
    expect(cfg.providers.astron.models).toEqual(['glm-5.2', 'glm-4'])
    // deepseek 保留
    expect(cfg.providers.deepseek.apiKey).toBe('sk-d')
    // default 不动（仍 astron，不擅自切）
    expect(cfg.current.name).toBe('astron')
  })

  it('保留 config 注释（modify 文本偏移编辑不删注释）', () => {
    const withComment = `{
  // 我的配置注释（应保留）
  "default": { "provider": "astron", "model": "glm-5.2" },
  "providers": { "astron": { "type": "anthropic", "baseURL": "http://a", "apiKey": "sk", "models": ["glm-5.2"] } }
}`
    writeConfig(withComment)
    writeWizardConfig(
      { mode: 'add', providerName: 'deepseek', type: 'openai', baseURL: 'http://d', apiKey: 'sk-d', models: 'ds', thinking: 'off' },
      { configPath: cfgPath },
    )
    const after = fs.readFileSync(cfgPath, 'utf8')
    expect(after).toContain('我的配置注释（应保留）')
  })

  it('特殊字符 apiKey（含 "/\/换行）→ round-trip 正确（P1-4）', () => {
    writeWizardConfig(
      { mode: 'add', providerName: 'x', type: 'anthropic', baseURL: 'http://x/"weird"', apiKey: 'sk-"k"\\with\nnl', models: 'm', thinking: 'off' },
      { configPath: cfgPath },
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.providers.x.apiKey).toBe('sk-"k"\\with\nnl')
    expect(cfg.providers.x.baseURL).toBe('http://x/"weird"')
  })

  it('空 apiKey → throw SETUP_INCOMPLETE 且不写文件（P1-4）', () => {
    const emptyPath = path.join(tmp, 'empty.json')
    expect(() =>
      writeWizardConfig(
        { mode: 'add', providerName: 'x', type: 'anthropic', baseURL: 'http://x', apiKey: '   ', models: 'm', thinking: 'off' },
        { configPath: emptyPath },
      ),
    ).toThrow(/SETUP_INCOMPLETE/)
    expect(fs.existsSync(emptyPath)).toBe(false)
  })

  it('写前备份现有 config → config.json.bak（P1-5）', () => {
    writeConfig('{"old":"config"}')
    writeWizardConfig(
      { mode: 'add', providerName: 'x', type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: 'm', thinking: 'off' },
      { configPath: cfgPath },
    )
    expect(fs.existsSync(cfgPath + '.bak')).toBe(true)
    expect(fs.readFileSync(cfgPath + '.bak', 'utf8')).toBe('{"old":"config"}')
  })
})

describe('emptyShellConfig', () => {
  it('空壳结构（providers 空 + current 空，供配置无效态）', () => {
    const cfg = emptyShellConfig()
    expect(cfg.providers).toEqual({})
    expect(cfg.current).toEqual({ name: '', model: '' })
    expect(cfg.maxIterations).toBe(50)
    expect(cfg.bashMaxOutputBytes).toBe(50000)
    expect(cfg.logLevel).toBe('info')
  })
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

  it('批2d 两新键缺省 → notificationIdleSeconds=60 / bellOnApproval=true', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.notificationIdleSeconds).toBe(60)
    expect(cfg.bellOnApproval).toBe(true)
  })

  it('批2d 两新键显式配置 → 覆盖默认（0=关闭 idle/approval 通知；false=关响铃）', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
        notificationIdleSeconds: 120,
        bellOnApproval: false,
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.notificationIdleSeconds).toBe(120)
    expect(cfg.bellOnApproval).toBe(false)
  })

  it('maxInstructions 缺省 → 50', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a' },
        providers: { a: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk', models: ['m'] } },
      }),
    )
    const cfg = loadConfig({ configPath: cfgPath, loadDotenv: false })
    expect(cfg.maxIterations).toBe(50)
  })

  it('外部注入 env 压过 .env 文件（dotenv 原生"不覆盖"语义——批2a 首版回归锁）', () => {
    // 场景：cwd 有 .env 写着端点 A，spawn/shell 注入端点 B（探针 mock/CI/多环境）——B 必须赢。
    // 批2a 首版 dotenvMap 优先致探针注入 mock 失效走了真 LLM（2026-08-28 外部验收实证）。
    writeConfig(
      JSON.stringify({
        default: { provider: 'astron', model: 'old' },
        providers: { astron: { type: 'anthropic', baseURL: 'http://file-env-cfg', apiKey: 'sk-c', models: ['old'] } },
      }),
    )
    const dir = path.join(tmp, `dotenv-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'ECODE_BASE_URL=http://file-env\nECODE_MODEL=file-model\n')
    process.env.ECODE_BASE_URL = 'http://injected-env'
    process.env.ECODE_MODEL = 'injected-model'
    try {
      const cfg = loadConfig({ configPath: cfgPath, cwd: dir })
      expect(cfg.providers.astron.baseURL).toBe('http://injected-env')
      expect(cfg.current.model).toBe('injected-model')
    } finally {
      delete process.env.ECODE_BASE_URL
      delete process.env.ECODE_MODEL
    }
  })

  it('F-18 根修回归锁（批2c）：loadConfig 读 .env 后绝不 mutate process.env（防 dotenv.config 复发）', () => {
    // 旧实现 dotenv.config() 把 .env 的 apiKey 提升进宿主 env，再经 spawnShellCommand
    // 全量继承透传给所有子进程（exfil 链，角色 C 三段实证）。快照对比锁死：读完 .env 后
    // 宿主 env 必须逐字节不变（含 ANTHROPIC_API_KEY/ECODE_* 键不得出现）。
    writeConfig(
      JSON.stringify({
        default: { provider: 'astron', model: 'old' },
        providers: { astron: { type: 'anthropic', baseURL: 'http://x', apiKey: 'sk-c', models: ['old'] } },
      }),
    )
    const dir = path.join(tmp, `nomutate-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-mutate-probe\nECODE_BASE_URL=http://mutate-probe\nECODE_MODEL=mutate-probe\n')
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ECODE_BASE_URL
    delete process.env.ECODE_MODEL
    const before = JSON.stringify(process.env)
    try {
      const cfg = loadConfig({ configPath: cfgPath, cwd: dir })
      expect(JSON.stringify(process.env)).toBe(before) // 宿主 env 逐字节不变
      // 同时 .env 值在 Config 生效（dotenvMap 主链不回退）
      expect(cfg.providers.astron.apiKey).toBe('sk-mutate-probe')
      expect(cfg.providers.astron.baseURL).toBe('http://mutate-probe')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ECODE_BASE_URL
      delete process.env.ECODE_MODEL
    }
  })

  it('loadDotenvMap（批2c）：只读解析 .env，不 mutate process.env；无 .env → 空 map', () => {
    const dir = path.join(tmp, `ldm-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'ECODE_MCP_X=1\n')
    delete process.env['ECODE_MCP_X']
    const before = JSON.stringify(process.env)
    expect(loadDotenvMap(dir)).toEqual({ ECODE_MCP_X: '1' })
    expect(loadDotenvMap(path.join(tmp, 'nope-empty'))).toEqual({})
    expect(JSON.stringify(process.env)).toBe(before)
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
    expect(cfg.bashMaxOutputBytes).toBe(50000)
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

  it('损坏的 config（非法 JSON）→ 抛错且不覆盖原文件（P0-1）', () => {
    writeConfig('{ "default": invalid !!! garbage }')
    const before = fs.readFileSync(cfgPath, 'utf8')
    // jsonc-parser 容错（不抛，返回部分对象）→ loadConfig 走校验失败（NO_API_KEY 等）；
    // 关键是不管抛什么错，写坏的文件不能被模板覆盖（用户数据不丢）
    expect(() => loadConfig({ configPath: cfgPath, loadDotenv: false })).toThrow()
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before)
  })
})

describe('文件权限（安全审阅 P1：chmod 显式兑现，POSIX 才可断言）', () => {
  it.skipIf(process.platform === 'win32')('loadConfig 首次生成模板 → 文件 0600 + 目录 0700', () => {
    const fresh = path.join(tmp, `fresh-${Date.now()}`, 'config.json')
    try {
      loadConfig({ configPath: fresh, loadDotenv: false })
    } catch {
      // NO_API_KEY 预期抛出——模板文件已生成，权限断言照做
    }
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(fresh)).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('writeWizardConfig → 文件 0600 + .bak 同样 0600', () => {
    writeConfig(
      JSON.stringify({
        default: { provider: 'a', model: 'm' },
        providers: { a: { type: 'anthropic', baseURL: 'http://a', apiKey: 'sk-a', models: ['m'] } },
      }),
    )
    writeWizardConfig(
      { mode: 'edit', providerName: 'a', type: 'anthropic', baseURL: 'http://a2', apiKey: 'sk-a2', models: 'm', thinking: 'off' },
      { configPath: cfgPath },
    )
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(cfgPath + '.bak').mode & 0o777).toBe(0o600)
  })
})
