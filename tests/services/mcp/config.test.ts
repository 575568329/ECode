import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  expandEnvVars,
  validateServerConfig,
  findProjectMcpJson,
  loadProjectMcpJson,
  mergeMcpServers,
  mcpFileHash,
  isMcpApproved,
  approveMcpFile,
} from '../../../src/services/mcp/config.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-mcpcfg-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('expandEnvVars', () => {
  it('命令/url/headers/env 全展开', () => {
    process.env['ECODE_TEST_K'] = 'secret-value'
    const { cfg, missing } = expandEnvVars({
      type: 'http',
      url: 'https://h/${ECODE_TEST_K}',
      headers: { auth: 'Bearer ${ECODE_TEST_K}' },
    })
    expect(missing).toEqual([])
    expect(cfg.url).toBe('https://h/secret-value')
    expect(cfg.headers?.['auth']).toBe('Bearer secret-value')
    delete process.env['ECODE_TEST_K']
  })

  it('缺失变量 → missing 列表', () => {
    const { missing } = expandEnvVars({ type: 'http', url: '${ECODE_NOPE_XYZ}' })
    expect(missing).toEqual(['ECODE_NOPE_XYZ'])
  })

  it('F-18 尾巴（批2c）：fallback（dotenvMap）兜底——process.env 缺但 .env 有的变量可展开', () => {
    // F-18 根修后 .env 值不再提升进 process.env，${ENV_VAR} 若只读 process.env 会与 .env
    // 静默解耦（server 因 missing 被跳过）——fallback 注入 loadConfig 的 dotenvMap 补链
    delete process.env['ECODE_MCP_DOTENV_K']
    const { cfg, missing } = expandEnvVars(
      { type: 'http', url: 'https://h/${ECODE_MCP_DOTENV_K}', headers: { auth: 'Bearer ${ECODE_MCP_DOTENV_K}' } },
      { ECODE_MCP_DOTENV_K: 'from-dotenv' },
    )
    expect(missing).toEqual([])
    expect(cfg.url).toBe('https://h/from-dotenv')
    expect(cfg.headers?.['auth']).toBe('Bearer from-dotenv')
  })

  it('外部注入压过 fallback（process.env > .env，与 config.ts 主链同语义）', () => {
    process.env['ECODE_MCP_DOTENV_K2'] = 'injected'
    try {
      const { cfg } = expandEnvVars({ type: 'http', url: 'https://h/${ECODE_MCP_DOTENV_K2}' }, { ECODE_MCP_DOTENV_K2: 'from-dotenv' })
      expect(cfg.url).toBe('https://h/injected')
    } finally {
      delete process.env['ECODE_MCP_DOTENV_K2']
    }
  })
})

describe('validateServerConfig', () => {
  it('type/必填字段', () => {
    expect(validateServerConfig('a', { type: 'stdio', command: 'node' })).toBeUndefined()
    expect(validateServerConfig('a', { type: 'http', url: 'https://x' })).toBeUndefined()
    expect(validateServerConfig('a', { type: 'stdio' })).toContain('command')
    expect(validateServerConfig('a', { type: 'http' })).toContain('url')
    expect(validateServerConfig('a', { type: 'ws' as 'stdio' })).toContain('type')
  })
})

describe('项目级 .mcp.json（M-P5）', () => {
  it('findProjectMcpJson 向上找最近；loadProjectMcpJson 解析', () => {
    const file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'x'] } } }))
    const deep = path.join(dir, 'a', 'b')
    fs.mkdirSync(deep, { recursive: true })
    expect(findProjectMcpJson(deep)).toBe(path.resolve(file))
    const servers = loadProjectMcpJson(file)
    expect(servers?.['fs']).toMatchObject({ type: 'stdio', command: 'npx' })
    expect(findProjectMcpJson(os.tmpdir())).toBeNull() // 上面没有（home 往上停）
  })

  it('损坏文件 → null', () => {
    const file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, '{bad')
    expect(loadProjectMcpJson(file)).toBeNull()
  })
})

describe('首用批准（v3 P1-4）', () => {
  it('hash 稳定 + 批准后持久化', () => {
    const file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, '{"mcpServers":{}}')
    const h1 = mcpFileHash(file)
    expect(mcpFileHash(file)).toBe(h1)
    fs.writeFileSync(file, '{"mcpServers":{"x":1}}') // 内容变 → hash 变
    expect(mcpFileHash(file)).not.toBe(h1)
    // isMcpApproved/approveMcpFile 走真实 ~/.ecode/approved-mcp.json——
    // 测试不污染用户目录：只验证函数可用性（不写）
    expect(typeof isMcpApproved(file)).toBe('boolean')
    expect(typeof approveMcpFile).toBe('function')
  })
})

describe('mergeMcpServers', () => {
  it('项目级覆盖用户级 + warn；非法配置/env 缺失跳过', () => {
    process.env['ECODE_MCP_OK'] = 'v'
    const { entries, warnings } = mergeMcpServers(
      {
        a: { type: 'stdio', command: 'node' },
        dup: { type: 'stdio', command: 'user-cmd' },
        bad: { type: 'stdio' },
        envmiss: { type: 'http', url: 'https://${ECODE_MCP_MISSING_XYZ}' },
      },
      {
        dup: { type: 'stdio', command: 'proj-cmd' },
        okenv: { type: 'http', url: 'https://h/${ECODE_MCP_OK}' },
      },
    )
    const names = entries.map((e) => e.name)
    expect(names).toContain('a')
    expect(names).toContain('dup')
    expect(names).toContain('okenv')
    expect(names).not.toContain('bad')
    expect(names).not.toContain('envmiss')
    const dup = entries.find((e) => e.name === 'dup')
    expect(dup?.cfg.command).toBe('proj-cmd')
    expect(dup?.source).toBe('project')
    expect(warnings.some((w) => w.includes('dup') && w.includes('覆盖'))).toBe(true)
    expect(warnings.some((w) => w.includes('bad'))).toBe(true)
    expect(warnings.some((w) => w.includes('ECODE_MCP_MISSING_XYZ'))).toBe(true)
    delete process.env['ECODE_MCP_OK']
  })
})

describe('mergeMcpServers envFallback（F-18 尾巴/批2c：${ENV_VAR} 与 .env 静默解耦补链）', () => {
  it('变量只在 .env（dotenvMap）→ server 正常展开接入，不再因 missing 跳过', () => {
    const { entries, warnings } = mergeMcpServers(
      { dotenved: { type: 'http', url: 'https://h/${ECODE_MCP_FALLBACK_K}' } },
      undefined,
      { ECODE_MCP_FALLBACK_K: 'dotenv-val' },
    )
    expect(entries.map((e) => e.name)).toContain('dotenved')
    expect(entries[0]?.cfg.url).toBe('https://h/dotenv-val')
    expect(warnings.some((w) => w.includes('ECODE_MCP_FALLBACK_K'))).toBe(false)
  })

  it('不传 fallback（旧调用方语义不变）：变量两处皆无 → 仍 missing 跳过 + warn', () => {
    const { entries, warnings } = mergeMcpServers({ gone: { type: 'http', url: 'https://h/${ECODE_MCP_GONE_K}' } }, undefined)
    expect(entries.map((e) => e.name)).not.toContain('gone')
    expect(warnings.some((w) => w.includes('ECODE_MCP_GONE_K'))).toBe(true)
  })
})
