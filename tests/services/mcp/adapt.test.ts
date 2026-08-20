import { describe, it, expect, vi } from 'vitest'
import {
  adaptTool,
  normalizeSchema,
  renderContent,
  sanitizeToolName,
  sanitizedProcessEnv,
  spawnSpec,
} from '../../../src/services/mcp/adapt.js'
import type { McpManager, McpContentItem } from '../../../src/services/mcp/manager.js'
import type { McpServerConfig } from '../../../src/services/mcp/config.js'

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }
const cfg: McpServerConfig = { type: 'stdio', command: 'node', args: ['s.js'] }

function fakeManager(over: Partial<Record<'getClientFor' | 'beginCall' | 'endCall' | 'markBroken'>> = {}): McpManager {
  return {
    beginCall: vi.fn(),
    endCall: vi.fn(),
    markBroken: vi.fn(),
    getClientFor: vi.fn(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [{ type: 'text', text: '结果' }] }),
      close: async () => {},
    })),
    ...over,
  } as unknown as McpManager
}

describe('sanitizeToolName', () => {
  it('非法字符 → -，限长', () => {
    expect(sanitizeToolName('read_file')).toBe('read_file')
    expect(sanitizeToolName('a b/c:d')).toBe('a-b-c-d')
  })
})

describe('spawnSpec（win32 npx 包 cmd /c，审阅补测）', () => {
  it('npx 类命令 → cmd /c 包裹；普通命令原样', () => {
    const npx = spawnSpec({ type: 'stdio', command: 'npx', args: ['-y', 'srv'] })
    expect(npx.command).toBe('cmd')
    expect(npx.args).toEqual(['/c', 'npx', '-y', 'srv'])
    const npm = spawnSpec({ type: 'stdio', command: 'npm.cmd', args: ['x'] })
    expect(npm.args[0]).toBe('/c')
    const node = spawnSpec({ type: 'stdio', command: 'node', args: ['s.js'] })
    expect(node.command).toBe('node')
    expect(node.args).toEqual(['s.js'])
  })
})

describe('sanitizedProcessEnv（安全审阅 P1：密钥 deny-list，不整份继承宿主 env）', () => {
  it('密钥形态变量被剔除，普通变量保留', () => {
    const env = sanitizedProcessEnv({
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
      APIKEY: 'k',
      FOO_TOKEN: 't',
      MY_SECRET: 's',
      PASSWORD: 'p',
      DB_CREDENTIALS: 'c',
      SESSION_COOKIE: 'ck',
      PATH: 'p',
      HOME: 'h',
      LANG: 'zh_CN.UTF-8',
      SSL_CERT_DIR: 'd',
    })
    expect(env).toEqual({ PATH: 'p', HOME: 'h', LANG: 'zh_CN.UTF-8', SSL_CERT_DIR: 'd' })
  })

  it('大小写不敏感匹配（Windows env 键大小写不定）', () => {
    const env = sanitizedProcessEnv({ anthropic_api_key: 'sk', MyToken: 't' })
    expect(env).toEqual({})
  })

  it('复审补充：分段式匹配兜住不含完整关键词的密钥变体', () => {
    const env = sanitizedProcessEnv({
      AWS_ACCESS_KEY_ID: 'ak', // _KEY_ 段（旧 API_?KEY 漏）
      GH_PAT: 't', // 个人访问令牌缩写
      MYSQL_PASS: 'p', // PASS 段
      DB_PW: 'pw', // PW 段
      SSH_PRIVATE_KEY: 'k', // _KEY$ 段
      // 公钥类变量会被一并剔除（从紧取向；server 需要时 cfg.env 显式配置覆盖）
      PUBLIC_KEY: 'pub',
    })
    expect(env).toEqual({})
    // 普通变量不误伤：分段边界（KEYCLOAK 整段 ≠ KEY 段）
    const keep = sanitizedProcessEnv({ KEYCLOAK_URL: 'u', PATH: 'p', MONKEY_COUNT: '1' })
    expect(keep).toEqual({ KEYCLOAK_URL: 'u', PATH: 'p', MONKEY_COUNT: '1' })
  })
})

describe('normalizeSchema', () =>{
  it('undefined → 最小 object', () => {
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('剥 $defs / $ref 降级 string / oneOf 丢弃 / properties 上限', () => {
    const schema = {
      type: 'object',
      $defs: { Foo: { type: 'string' } },
      oneOf: [{ type: 'object' }],
      properties: {
        plain: { type: 'string' },
        refd: { $ref: '#/$defs/Foo' },
        nested: { type: 'object', properties: { deep: { $ref: 'https://ext/Bar' } } },
      },
    }
    const out = normalizeSchema(schema) as Record<string, unknown>
    const props = (out['properties'] ?? {}) as Record<string, unknown>
    expect(out['$defs']).toBeUndefined()
    expect(out['oneOf']).toBeUndefined()
    expect(props['plain']).toEqual({ type: 'string' })
    const refd = props['refd'] as Record<string, unknown>
    expect(refd['type']).toBe('string')
    const nested = props['nested'] as Record<string, unknown>
    const deep = (nested['properties'] as Record<string, unknown>)['deep'] as Record<string, unknown>
    expect(deep['type']).toBe('string') // 外部 $ref 也降级
  })
})

describe('renderContent', () => {
  it('多类型分派', () => {
    const items: McpContentItem[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'xxxx' },
      { type: 'resource_link', uri: 'file:///a.txt' },
      { type: 'resource', uri: 'db://t' },
      { type: 'weird' },
    ]
    const out = renderContent(items)
    expect(out).toContain('hello')
    expect(out).toContain('[图片 image/png')
    expect(out).toContain('[资源] file:///a.txt')
    expect(out).toContain('[资源] db://t')
    expect(out).toContain('[weird]')
  })

  it('空 → 占位', () => {
    expect(renderContent(undefined)).toContain('无内容')
    expect(renderContent([])).toContain('无内容')
  })
})

describe('adaptTool', () => {
  it('命名前缀 + readonly=false + skipLocalValidate', () => {
    const t = adaptTool('fs', { name: 'read_file', description: '读' }, fakeManager(), cfg)
    expect(t.name).toBe('mcp__fs__read_file')
    expect(t.readonly).toBe(false)
    expect(t.skipLocalValidate).toBe(true)
    expect(t.timeout_ms).toBe(30_000)
  })

  it('execute：lazyConnect（getClientFor）→ callTool → text 渲染；touch/begin/end', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok-result' }] }))
    const getClientFor = vi.fn(async () => ({
      listTools: async () => ({ tools: [] }),
      callTool,
      close: async () => {},
    }))
    const beginCall = vi.fn()
    const endCall = vi.fn()
    const mgr = fakeManager({ getClientFor, beginCall, endCall })
    const t = adaptTool('fs', { name: 'read' }, mgr, cfg)
    const r = await t.execute({ p: 1 }, ctx)
    expect(r).toEqual({ content: 'ok-result', is_error: false })
    expect(getClientFor).toHaveBeenCalledWith('fs', ctx.signal)
    expect(callTool).toHaveBeenCalledWith({ name: 'read', arguments: { p: 1 } }, expect.anything())
    expect(beginCall).toHaveBeenCalledWith('fs')
    expect(endCall).toHaveBeenCalledWith('fs')
  })

  it('副作用快照兜底（M9-P1 覆盖面补齐）：execute 前 onBeforeWrite([], mcp 名)——与 bash 同款', async () => {
    const onBeforeWrite = vi.fn(async () => {})
    const t = adaptTool('fs', { name: 'write_file', description: '写' }, fakeManager(), cfg)
    await t.execute({ p: 1 }, { ...ctx, onBeforeWrite })
    expect(onBeforeWrite).toHaveBeenCalledWith([], 'mcp__fs__write_file')
  })

  it('isError → is_error:true（recoverable 回喂）', async () => {
    const mgr = fakeManager({
      getClientFor: vi.fn(async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [{ type: 'text', text: '业务错误' }], isError: true }),
        close: async () => {},
      })),
    })
    const r = await adaptTool('fs', { name: 'x' }, mgr, cfg).execute({}, ctx)
    expect(r.is_error).toBe(true)
  })

  it('传输层错误 → markBroken + is_error', async () => {
    const markBroken = vi.fn()
    const mgr = fakeManager({
      markBroken,
      getClientFor: vi.fn(async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          throw new Error('read ECONNRESET')
        },
        close: async () => {},
      })),
    })
    const r = await adaptTool('fs', { name: 'x' }, mgr, cfg).execute({}, ctx)
    expect(r.is_error).toBe(true)
    expect(markBroken).toHaveBeenCalledWith('fs', 'read ECONNRESET')
  })

  it('普通错误 → is_error 不 markBroken', async () => {
    const markBroken = vi.fn()
    const mgr = fakeManager({
      markBroken,
      getClientFor: vi.fn(async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          throw new Error('参数错误')
        },
        close: async () => {},
      })),
    })
    const r = await adaptTool('fs', { name: 'x' }, mgr, cfg).execute({}, ctx)
    expect(r.is_error).toBe(true)
    expect(markBroken).not.toHaveBeenCalled()
  })
})
