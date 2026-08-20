import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discoverComponents,
  findManifestFile,
  parsePluginManifest,
  sanitizeRelPath,
  sanitizeVersion,
} from '../../../src/services/plugin/manifest.js'
import { parseMarketplaceManifest } from '../../../src/services/plugin/marketplace.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `ecode-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmpRoot, { recursive: true })
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function writePlugin(files: Record<string, string>): Promise<string> {
  const root = path.join(tmpRoot, 'my-plugin')
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel)
    await mkdir(path.dirname(f), { recursive: true })
    await writeFile(f, content, 'utf8')
  }
  return root
}

describe('parsePluginManifest', () => {
  it('极简约定型（元数据 + 组件靠目录）', () => {
    const m = parsePluginManifest(
      JSON.stringify({ name: 'context7', description: 'doc query', author: { name: 'Upstash' } }),
      'test',
    )
    expect(m.name).toBe('context7')
    expect(m.version).toBe('0.0.0')
    expect(m.author?.name).toBe('Upstash')
    expect(m.skills).toBeUndefined()
  })

  it('未知字段剥离 + version 净化', () => {
    const m = parsePluginManifest(
      JSON.stringify({ name: 'p1', version: '1.0..BETA/x', customField: { x: 1 } }),
      'test',
    )
    expect(m.version).toBe('1.0..BETA-x')
    expect((m as unknown as Record<string, unknown>).customField).toBeUndefined()
  })

  it('非法 name（大写/裸特殊字符/官方保留名）→ throw', () => {
    expect(() => parsePluginManifest(JSON.stringify({ name: 'BadName' }), 't')).toThrow()
    expect(() => parsePluginManifest(JSON.stringify({ name: '.hidden' }), 't')).toThrow()
    expect(() => parsePluginManifest(JSON.stringify({ name: 'ecode' }), 't')).toThrow('官方保留')
    expect(() => parsePluginManifest('not json', 't')).toThrow('解析失败')
  })

  it('非对象 / 缺 name → throw', () => {
    expect(() => parsePluginManifest('[]', 't')).toThrow('校验失败')
    expect(() => parsePluginManifest('{}', 't')).toThrow('校验失败')
  })

  it('hooks 声明走 parseHookSpecs（非法项跳过）', () => {
    const m = parsePluginManifest(
      JSON.stringify({
        name: 'p2',
        hooks: [{ event: 'Stop', handler: { kind: 'command', command: 'echo done' } }, { event: 'Bad' }],
      }),
      't',
    )
    expect(m.hooks).toHaveLength(1)
  })
})

describe('sanitizeRelPath / sanitizeVersion', () => {
  it('合法相对路径保留', () => {
    expect(sanitizeRelPath('skills')).toBe('skills')
    expect(sanitizeRelPath('./a/b')).toBe('a/b')
  })
  it('穿越/绝对/盘符拒绝', () => {
    expect(sanitizeRelPath('..')).toBeNull()
    expect(sanitizeRelPath('../x')).toBeNull()
    expect(sanitizeRelPath('a/../../x')).toBeNull()
    expect(sanitizeRelPath('/etc')).toBeNull()
    expect(sanitizeRelPath('C:/x')).toBeNull()
  })
  it('版本净化', () => {
    expect(sanitizeVersion('1.0.0')).toBe('1.0.0')
    expect(sanitizeVersion('v1 0')).toBe('v1-0')
  })
})

describe('findManifestFile（双目录探测）', () => {
  it('.ecode-plugin 优先', async () => {
    const root = await writePlugin({
      '.ecode-plugin/plugin.json': JSON.stringify({ name: 'a' }),
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'b' }),
    })
    const f = findManifestFile(root)
    expect(f?.includes('.ecode-plugin')).toBe(true)
  })
  it('.claude-plugin 回退', async () => {
    const root = await writePlugin({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'c' }) })
    expect(findManifestFile(root)?.includes('.claude-plugin')).toBe(true)
  })
  it('都没有 → null', async () => {
    const root = await writePlugin({ 'README.md': 'x' })
    expect(findManifestFile(root)).toBeNull()
  })
})

describe('discoverComponents（约定 + 声明）', () => {
  it('目录约定：skills/commands/.mcp.json/hooks 存在即扫', async () => {
    const root = await writePlugin({
      '.ecode-plugin/plugin.json': JSON.stringify({ name: 'p' }),
      'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\nbody',
      'commands/c.md': '# c',
      '.mcp.json': JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'node' } } }),
      'hooks/hooks.json': JSON.stringify([{ event: 'Stop', handler: { kind: 'command', command: 'x' } }]),
    })
    const m = parsePluginManifest(
      await import('node:fs').then((fs) => fs.readFileSync(path.join(root, '.ecode-plugin/plugin.json'), 'utf8')),
      't',
    )
    const c = discoverComponents(root, m)
    expect(c.skillsDirs).toEqual([path.join(root, 'skills')])
    expect(c.commandsDirs).toEqual([path.join(root, 'commands')])
    expect(c.mcpServers.fs).toEqual({ type: 'stdio', command: 'node' })
    expect(c.hooks).toHaveLength(1)
    expect(c.warnings).toHaveLength(0)
  })

  it('显式声明覆盖约定；声明目录不存在 → warning 跳过', async () => {
    const root = await writePlugin({
      '.ecode-plugin/plugin.json': JSON.stringify({ name: 'p', skills: ['my-skills', 'gone'] }),
      'my-skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\nbody',
    })
    const m = parsePluginManifest(JSON.stringify({ name: 'p', skills: ['my-skills', 'gone'] }), 't')
    const c = discoverComponents(root, m)
    expect(c.skillsDirs).toEqual([path.join(root, 'my-skills')])
    expect(c.warnings.some((w) => w.includes('gone'))).toBe(true)
  })

  it('清单 mcpServers 覆盖 .mcp.json 同名', async () => {
    const root = await writePlugin({
      '.ecode-plugin/plugin.json': JSON.stringify({
        name: 'p',
        mcpServers: { fs: { type: 'stdio', command: 'node2' } },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'node' }, other: { type: 'http', url: 'http://x' } } }),
    })
    const m = parsePluginManifest(
      await import('node:fs').then((fs) => fs.readFileSync(path.join(root, '.ecode-plugin/plugin.json'), 'utf8')),
      't',
    )
    const c = discoverComponents(root, m)
    expect(c.mcpServers.fs).toEqual({ type: 'stdio', command: 'node2' })
    expect(c.mcpServers.other).toBeDefined()
  })
})

describe('parseMarketplaceManifest', () => {
  it('三类 source 合法解析', () => {
    const m = parseMarketplaceManifest(
      JSON.stringify({
        name: 'mkt',
        plugins: [
          { name: 'a', source: { source: 'github', repo: 'upstash/context7-mcp', ref: 'v0.1.0' } },
          { name: 'b', source: { source: 'url', url: 'https://x/y.zip', sha256: 'ab'.repeat(32) } },
          { name: 'c', source: { source: 'local', path: './plugins/c' } },
        ],
      }),
      't',
    )
    expect(m.name).toBe('mkt')
    expect(m.plugins).toHaveLength(3)
    expect(m.plugins[0]?.source).toEqual({ source: 'github', repo: 'upstash/context7-mcp', ref: 'v0.1.0' })
  })

  it('缺 name/plugins、repo 格式错、非 http url → throw', () => {
    expect(() => parseMarketplaceManifest('{}', 't')).toThrow()
    expect(() => parseMarketplaceManifest(JSON.stringify({ name: 'm', plugins: [{ name: 'x' }] }), 't')).toThrow()
    expect(() =>
      parseMarketplaceManifest(JSON.stringify({ name: 'm', plugins: [{ name: 'x', source: { source: 'github', repo: 'bad' } }] }), 't'),
    ).toThrow()
    expect(() =>
      parseMarketplaceManifest(JSON.stringify({ name: 'm', plugins: [{ name: 'x', source: { source: 'url', url: 'ftp://x' } }] }), 't'),
    ).toThrow()
  })

  it('安全审阅 P2：url 源缺 sha256 或非 64hex → throw（拒装，无完整性校验不可装）', () => {
    expect(() =>
      parseMarketplaceManifest(JSON.stringify({ name: 'm', plugins: [{ name: 'x', source: { source: 'url', url: 'https://x/y.zip' } }] }), 't'),
    ).toThrow()
    expect(() =>
      parseMarketplaceManifest(JSON.stringify({ name: 'm', plugins: [{ name: 'x', source: { source: 'url', url: 'https://x/y.zip', sha256: 'deadbeef' } }] }), 't'),
    ).toThrow()
  })
})
