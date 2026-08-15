import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLoader, type PluginLoaderDeps } from '../../../src/services/plugin/loader.js'
import { parseMarketplaceManifest } from '../../../src/services/plugin/marketplace.js'
import { findManifestFile } from '../../../src/services/plugin/manifest.js'
import { SkillRegistry } from '../../../src/services/skill.js'
import { globalExtensionHooks } from '../../../src/services/hooks/global.js'
import * as fsSync from 'node:fs'

let tmpRoot: string
let baseDir: string
let configPath: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ecode-plugin-loader-'))
  baseDir = path.join(tmpRoot, 'plugins')
  configPath = path.join(tmpRoot, 'config.json')
  await writeFile(configPath, '{\n  // 注释要保留\n  "maxIterations": 50\n}\n', 'utf8')
  globalExtensionHooks.rebuild([])
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
  globalExtensionHooks.rebuild([])
})

function makeLoader(overrides: Partial<PluginLoaderDeps> = {}): PluginLoader {
  return new PluginLoader({ baseDir, configPath, ...overrides })
}

/** 造一个本地市场：n 个插件（local source 指向市场内目录）。 */
async function makeLocalMarket(marketName: string, plugins: Array<{ name: string; files?: Record<string, string> }>): Promise<string> {
  const mktDir = path.join(tmpRoot, 'src-market', marketName)
  const entries: unknown[] = []
  for (const p of plugins) {
    const dir = path.join(mktDir, 'plugins', p.name)
    await mkdir(path.join(dir, '.ecode-plugin'), { recursive: true })
    await writeFile(path.join(dir, '.ecode-plugin', 'plugin.json'), JSON.stringify({ name: p.name, version: '1.0.0', ...JSON.parse(p.files?.['manifest'] ?? '{}') }), 'utf8')
    for (const [rel, content] of Object.entries(p.files ?? {})) {
      if (rel === 'manifest') continue
      const f = path.join(dir, rel)
      await mkdir(path.dirname(f), { recursive: true })
      await writeFile(f, content, 'utf8')
    }
    entries.push({ name: p.name, source: { source: 'local', path: `./plugins/${p.name}` } })
  }
  await mkdir(path.join(mktDir, '.ecode-plugin'), { recursive: true })
  await writeFile(
    path.join(mktDir, '.ecode-plugin', 'marketplace.json'),
    JSON.stringify({ name: marketName, plugins: entries }),
    'utf8',
  )
  return mktDir
}

describe('PluginLoader：添加市场 + 浏览', () => {
  it('本地路径市场 → clone（cp）+ known 注册 + browse', async () => {
    await makeLocalMarket('team', [{ name: 'pack-a' }, { name: 'pack-b' }])
    const loader = makeLoader()
    const manifest = await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    expect(manifest.name).toBe('team')
    expect(loader.listMarketplaces()).toEqual(['team'])
    const browsed = loader.browse()
    expect(browsed).toHaveLength(1)
    expect(browsed[0]?.plugins.map((p) => p.name).sort()).toEqual(['pack-a', 'pack-b'])
    expect(browsed[0]?.plugins.every((p) => !p.installed)).toBe(true)
  })

  it('owner/repo → git clone（spawnImpl 捕获参数）', async () => {
    const spawnImpl = vi.fn(((cmd: string, args: string[]) => {
      // 模拟 git clone：最后参数是目标目录，往里写 marketplace（同步写——fake 是同步工厂）
      const target = args[args.length - 1] ?? ''
      fsSync.mkdirSync(path.join(target, '.ecode-plugin'), { recursive: true })
      fsSync.writeFileSync(path.join(target, '.ecode-plugin', 'marketplace.json'), JSON.stringify({ name: 'gh-mkt', plugins: [] }), 'utf8')
      return fakeChild(0)
    }) as unknown as PluginLoaderDeps['spawnImpl'])
    const loader = makeLoader({ spawnImpl })
    const manifest = await loader.addMarketplace('someone/some-market')
    expect(manifest.name).toBe('gh-mkt')
    expect(spawnImpl).toHaveBeenCalledWith('git', expect.arrayContaining(['clone', expect.stringContaining('github.com/someone/some-market')]), expect.anything())
  })

  it('市场缺 marketplace.json → throw', async () => {
    const empty = path.join(tmpRoot, 'empty-market')
    await mkdir(empty, { recursive: true })
    await expect(makeLoader().addMarketplace(empty)).rejects.toThrow('marketplace.json')
  })
})

describe('PluginLoader：安装（local source 主路径）', () => {
  it('install → cache 版本化落位 + config enable（注释保留）', async () => {
    await makeLocalMarket('team', [{
      name: 'pack-a',
      files: { 'skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\nbody' },
    }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    const r = await loader.install('pack-a', 'team')
    expect(r.version).toBe('1.0.0')
    expect(path.basename(r.path)).toBe('1.0.0')
    // config 注释保留 + plugins 键写入
    const cfgText = await readFile(configPath, 'utf8')
    expect(cfgText).toContain('注释要保留')
    expect(cfgText).toContain('"pack-a@team": true')
    // 已安装列表 + browse 标记
    expect(loader.list().map((p) => p.name)).toEqual(['pack-a'])
    expect(loader.browse()[0]?.plugins.find((p) => p.name === 'pack-a')?.installed).toBe(true)
  })

  it('清单一行 GitHub source → spawnImpl 收 clone --depth 1 + 去 .git', async () => {
    await makeLocalMarket('team2', [{ name: 'remote-pack' }])
    // 改 source 为 github
    const mktFile = path.join(baseDir, 'marketplaces', 'team2', '.ecode-plugin', 'marketplace.json')
    const loader0 = makeLoader()
    await loader0.addMarketplace(path.join(tmpRoot, 'src-market', 'team2'))
    const mkt = JSON.parse(await readFile(mktFile, 'utf8')) as { plugins: Array<{ name: string; source: unknown }> }
    mkt.plugins[0]!.source = { source: 'github', repo: 'acme/remote-pack', ref: 'v2.0.0' }
    await writeFile(mktFile, JSON.stringify(mkt), 'utf8')

    const spawnImpl = vi.fn(((cmd: string, args: string[]) => {
      const target = args[args.length - 1] ?? ''
      fsSync.mkdirSync(path.join(target, '.ecode-plugin'), { recursive: true })
      fsSync.mkdirSync(path.join(target, '.git'), { recursive: true })
      fsSync.writeFileSync(path.join(target, '.git', 'HEAD'), 'ref', 'utf8')
      fsSync.writeFileSync(path.join(target, '.ecode-plugin', 'plugin.json'), JSON.stringify({ name: 'remote-pack', version: '2.0.0' }), 'utf8')
      return fakeChild(0)
    })) as unknown as PluginLoaderDeps['spawnImpl']
    const loader = makeLoader({ spawnImpl })
    const r = await loader.install('remote-pack', 'team2')
    expect(spawnImpl).toHaveBeenCalledWith('git', expect.arrayContaining(['--branch', 'v2.0.0', '--depth', '1']), expect.anything())
    expect(r.version).toBe('2.0.0')
    // .git 已剥
    const { stat } = await import('node:fs/promises')
    await expect(stat(path.join(r.path, '.git'))).rejects.toThrow()
  })

  it('url source → fetch + sha256 校验（失败 throw）+ zip 剥根解压', async () => {
    await makeLocalMarket('team3', [{ name: 'zipped' }])
    const loader0 = makeLoader()
    await loader0.addMarketplace(path.join(tmpRoot, 'src-market', 'team3'))
    const mktFile = path.join(baseDir, 'marketplaces', 'team3', '.ecode-plugin', 'marketplace.json')
    const mkt = JSON.parse(await readFile(mktFile, 'utf8')) as { plugins: Array<{ name: string; source: unknown }> }

    // 构造带根目录的 zip
    const zip = new AdmZip()
    zip.addFile('zipped-main/.ecode-plugin/plugin.json', Buffer.from(JSON.stringify({ name: 'zipped', version: '3.0.0' })))
    zip.addFile('zipped-main/skills/z/SKILL.md', Buffer.from('---\nname: z\ndescription: d\n---\nbody'))
    const zipBuf = zip.toBuffer()
    const { createHash } = await import('node:crypto')
    const sha = createHash('sha256').update(zipBuf).digest('hex')
    mkt.plugins[0]!.source = { source: 'url', url: 'https://example.com/zipped.zip', sha256: sha }
    await writeFile(mktFile, JSON.stringify(mkt), 'utf8')

    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => zipBuf.slice().buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength) })) as unknown as PluginLoaderDeps['fetchImpl']
    const loader = makeLoader({ fetchImpl })
    const r = await loader.install('zipped', 'team3')
    expect(r.version).toBe('3.0.0')
    // 剥根：清单直接在 cache 根（而非 zipped-main/ 子目录下）
    expect(findManifestFile(r.path)).not.toBeNull()

    // 坏 sha → 拒绝
    mkt.plugins[0]!.source = { source: 'url', url: 'https://example.com/zipped.zip', sha256: 'deadbeef' }
    await writeFile(mktFile, JSON.stringify(mkt), 'utf8')
    await expect(loader.install('zipped', 'team3')).rejects.toThrow('sha256')
  })

  it('清单缺失 → 合成最小 manifest 安装仍成功', async () => {
    // 手工市场：plugin 无清单
    const mktDir = path.join(tmpRoot, 'bare-market')
    await mkdir(path.join(mktDir, 'plugins', 'bare'), { recursive: true })
    await mkdir(path.join(mktDir, '.ecode-plugin'), { recursive: true })
    await writeFile(
      path.join(mktDir, '.ecode-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'bare', plugins: [{ name: 'bare', source: { source: 'local', path: './plugins/bare' } }] }),
      'utf8',
    )
    const loader = makeLoader()
    await loader.addMarketplace(mktDir)
    const r = await loader.install('bare', 'bare')
    expect(r.version).toBe('0.0.0')
  })
})

describe('PluginLoader：启用/禁用/卸载', () => {
  it('disable → config false + list.enabled=false；enable 回 true', async () => {
    await makeLocalMarket('team', [{ name: 'p1' }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    await loader.install('p1', 'team')
    loader.setEnabled('p1', 'team', false)
    expect(loader.list()[0]?.enabled).toBe(false)
    loader.setEnabled('p1', 'team', true)
    expect(loader.list()[0]?.enabled).toBe(true)
  })

  it('uninstall → cache 目录删除 + config 键移除（注释保留）', async () => {
    await makeLocalMarket('team', [{ name: 'p2' }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    const r = await loader.install('p2', 'team')
    await loader.uninstall('p2', 'team')
    expect(loader.list()).toHaveLength(0)
    const cfgText = await readFile(configPath, 'utf8')
    expect(cfgText).toContain('注释要保留')
    expect(cfgText).not.toContain('p2@team')
    const { stat } = await import('node:fs/promises')
    await expect(stat(r.path)).rejects.toThrow()
  })
})

describe('PluginLoader：teardown 卸载链（P6.2）', () => {
  it('mcp removeServer + 工具 unregister + skill removeSource + hooks 注销', async () => {
    await makeLocalMarket('team', [{
      name: 't1',
      files: {
        'skills/s1/SKILL.md': '---\nname: s1\ndescription: d\n---\nb',
        'hooks/hooks.json': JSON.stringify([{ event: 'Stop', handler: { kind: 'command', command: 'x' } }]),
      },
    }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    await loader.install('t1', 'team')

    const skillReg = new SkillRegistry({ userDir: path.join(tmpRoot, 'my-skills') })
    // fake mcp：预先塞一个 plugin: 前缀 server + 工具
    const removedServers: string[] = []
    const fakeMcp = {
      serverNames: () => ['plugin:t1/srv', 'user-srv'],
      toolsOf: () => [{ name: 'do', description: 'd', inputSchema: {} }],
      removeServer: async (n: string) => { removedServers.push(n) },
    } as unknown as Parameters<PluginLoader['teardown']>[3]
    const unregistered: string[] = []
    const fakeTools = {
      unregister: (n: string) => { unregistered.push(n) },
    } as unknown as Parameters<PluginLoader['teardown']>[2]

    await loader.loadAll(skillReg, null)
    expect(skillReg.get('s1')?.source).toBe('plugin')

    const installed = loader.list()[0]
    expect(installed).toBeDefined()
    await loader.teardown(installed!, skillReg, fakeTools, fakeMcp)

    expect(removedServers).toEqual(['plugin:t1/srv']) // 用户级 server 不动
    expect(unregistered).toEqual(['mcp__plugin-t1-srv__do']) // 工具名净化同 M6
    expect(skillReg.get('s1')).toBeUndefined()
    expect(globalExtensionHooks.entries()).toHaveLength(0)
  })
})

describe('PluginLoader：安全修复（P0-1/P1-1/P1-2/P1-4）', () => {
  it('marketplace 恶意 name（路径穿越/绝对路径）→ 解析拒绝', () => {
    for (const badName of ['../../..', 'C:/x', '/abs', 'a/b', '.']) {
      expect(() =>
        parseMarketplaceManifest(JSON.stringify({ name: badName, plugins: [] }), 't'),
      ).toThrow()
    }
  })

  it('install local source path 穿越（./../../..）→ 拒绝', async () => {
    const mktDir = path.join(tmpRoot, 'evil-market')
    await mkdir(path.join(mktDir, '.ecode-plugin'), { recursive: true })
    await writeFile(
      path.join(mktDir, '.ecode-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'evil', plugins: [{ name: 'x', source: { source: 'local', path: './../../..' } }] }),
      'utf8',
    )
    const loader = makeLoader()
    await loader.addMarketplace(mktDir)
    await expect(loader.install('x', 'evil')).rejects.toThrow('非法')
  })

  it('git clone 失败（非零退出码）→ throw，不再合成空壳插件', async () => {
    await makeLocalMarket('badclone', [{ name: 'ghost' }])
    const loader0 = makeLoader()
    await loader0.addMarketplace(path.join(tmpRoot, 'src-market', 'badclone'))
    const mktFile = path.join(baseDir, 'marketplaces', 'badclone', '.ecode-plugin', 'marketplace.json')
    const mkt = JSON.parse(await readFile(mktFile, 'utf8')) as { plugins: Array<{ name: string; source: unknown }> }
    mkt.plugins[0]!.source = { source: 'github', repo: 'acme/ghost' }
    await writeFile(mktFile, JSON.stringify(mkt), 'utf8')
    const spawnImpl = (() => fakeChild(128)) as unknown as PluginLoaderDeps['spawnImpl']
    const loader = makeLoader({ spawnImpl })
    await expect(loader.install('ghost', 'badclone')).rejects.toThrow('git clone 失败')
  })

  it('github sha 校验：期望与实际不符 → 拒绝安装', async () => {
    await makeLocalMarket('shamkt', [{ name: 'sha-p' }])
    const loader0 = makeLoader()
    await loader0.addMarketplace(path.join(tmpRoot, 'src-market', 'shamkt'))
    const mktFile = path.join(baseDir, 'marketplaces', 'shamkt', '.ecode-plugin', 'marketplace.json')
    const mkt = JSON.parse(await readFile(mktFile, 'utf8')) as { plugins: Array<{ name: string; source: unknown }> }
    mkt.plugins[0]!.source = { source: 'github', repo: 'acme/sha-p', sha: 'deadbeef' }
    await writeFile(mktFile, JSON.stringify(mkt), 'utf8')
    const spawnImpl = ((cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return fakeChildWithStdout(0, 'abc123')
      const target = args[args.length - 1] ?? ''
      fsSync.mkdirSync(path.join(target, '.ecode-plugin'), { recursive: true })
      fsSync.writeFileSync(path.join(target, '.ecode-plugin', 'plugin.json'), JSON.stringify({ name: 'sha-p', version: '1.0.0' }), 'utf8')
      return fakeChild(0)
    }) as unknown as PluginLoaderDeps['spawnImpl']
    const loader = makeLoader({ spawnImpl })
    await expect(loader.install('sha-p', 'shamkt')).rejects.toThrow('sha 校验失败')
  })
})

describe('PluginLoader：loadAll 资源接入', () => {
  it('skills→addSource / mcp→plugin: 命名空间+占位符展开 / hooks→全局注册表', async () => {
    await makeLocalMarket('team', [{
      name: 'full',
      files: {
        manifest: JSON.stringify({
          mcpServers: { srv: { type: 'stdio', command: 'node', args: ['${ECODE_PLUGIN_ROOT}/dist/srv.js'] } },
          hooks: [{ event: 'Stop', handler: { kind: 'command', command: 'echo hi' } }],
        }),
        'skills/f1/SKILL.md': '---\nname: f1\ndescription: d\n---\nbody',
        'hooks/hooks.json': JSON.stringify([{ event: 'SessionStart', handler: { kind: 'command', command: 'echo start' } }]),
      },
    }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    const installed = await loader.install('full', 'team')

    const skillReg = new SkillRegistry({ userDir: path.join(tmpRoot, 'my-skills') })
    const mcpStart = vi.fn(async () => ({ connected: 0, failed: [] }))
    const fakeMcp = { start: mcpStart } as unknown as Parameters<PluginLoader['loadAll']>[1]
    const warnings = await loader.loadAll(skillReg, fakeMcp)

    expect(warnings).toHaveLength(0)
    expect(skillReg.get('f1')?.source).toBe('plugin')
    expect(mcpStart).toHaveBeenCalledTimes(1)
    const entry = (mcpStart.mock.calls[0]?.[0] as Array<{ name: string; cfg: { args?: string[] }; source: string }>)[0]
    expect(entry?.name).toBe('plugin:full/srv')
    expect(entry?.source).toBe('plugin')
    // win 下占位符替换是字符串级（混合分隔符 Node 容忍），断言归一化比较
    expect(entry?.cfg.args?.[0]?.split(path.sep).join('/')).toBe(
      path.join(installed.path, 'dist/srv.js').split(path.sep).join('/'),
    )
    // hooks：清单 + hooks.json 都注册
    const owners = globalExtensionHooks.entries()
    expect(owners).toHaveLength(1)
    expect(owners[0]?.owner).toBe('plugin:full@team')
    expect(owners[0]?.hooks).toHaveLength(2)
  })

  it('disabled 插件不接入', async () => {
    await makeLocalMarket('team', [{ name: 'off', files: { 'skills/o1/SKILL.md': '---\nname: o1\ndescription: d\n---\nb' } }])
    const loader = makeLoader()
    await loader.addMarketplace(path.join(tmpRoot, 'src-market', 'team'))
    await loader.install('off', 'team')
    loader.setEnabled('off', 'team', false)
    const skillReg = new SkillRegistry({ userDir: path.join(tmpRoot, 'my-skills') })
    await loader.loadAll(skillReg, null)
    expect(skillReg.get('o1')).toBeUndefined()
  })
})

/** fake ChildLike（立即 close 给定 code）。 */
function fakeChild(code: number): {
  on(event: string, cb: (a: never) => void): void
  kill(): void
} {
  return {
    on(event, cb) {
      if (event === 'close') queueMicrotask(() => cb(code as never))
    },
    kill() {},
  }
}

/** fake ChildLike + stdout（rev-parse 等需要输出的命令）。 */
function fakeChildWithStdout(code: number, stdout: string): {
  on(event: string, cb: (a: never) => void): void
  onStdout(cb: (d: Buffer) => void): void
  kill(): void
} {
  return {
    on(event, cb) {
      if (event === 'close') queueMicrotask(() => cb(code as never))
    },
    onStdout(cb) {
      cb(Buffer.from(stdout))
    },
    kill() {},
  }
}
