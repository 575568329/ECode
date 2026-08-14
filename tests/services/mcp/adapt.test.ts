import { describe, it, expect, vi } from 'vitest'
import {
  adaptTool,
  normalizeSchema,
  renderContent,
  sanitizeToolName,
  resolveCommand,
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

describe('resolveCommand', () => {
  it('win32 npx 保持（spawnSpec 层包 cmd）', () => {
    // 只验证纯函数不炸 + 幂等
    expect(typeof resolveCommand('node')).toBe('string')
    expect(resolveCommand('npx')).toBe('npx')
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
