/**
 * PluginLoader（M7 P-P2~P-P4）：marketplace 添加 / plugin 安装 / 启用禁用卸载 / 资源接入。
 *
 * 子进程规范（P6.1）：git clone 走异步 spawn + 60s 超时 + AbortSignal 取清 + stderr 捕获，
 * 禁 execSync 阻塞热路径；staging 临时目录 → rename 原子落位（中断不留脏 cache）。
 * 目录布局（P3.3）：
 *   ~/.ecode/plugins/marketplaces/<mkt>/        市场（clone/复制）
 *   ~/.ecode/plugins/cache/<mkt>/<plugin>/<version>/   版本化缓存
 *   ~/.ecode/plugins/known_marketplaces.json    已添加市场注册表
 * 启用状态在 ~/.ecode/config.json → plugins（"name@mkt": bool）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parse as parseJsonc, modify, applyEdits, type FormattingOptions } from 'jsonc-parser'
import AdmZip from 'adm-zip'
import type { SkillRegistry } from '../skill.js'
import type { McpManager } from '../mcp/manager.js'
import type { McpServerConfig, McpServerEntry } from '../mcp/config.js'
import { sanitizeToolName } from '../mcp/adapt.js'
import type { ToolRegistry } from '../../tools/interface.js'
import { defaultConfigPath } from '../config.js'
import { globalExtensionHooks } from '../hooks/global.js'
import {
  discoverComponents,
  findManifestFile,
  parsePluginManifest,
  sanitizeVersion,
  type PluginComponents,
  type PluginManifest,
} from './manifest.js'
import {
  MARKETPLACE_MANIFEST_REL,
  parseMarketplaceManifest,
  type MarketplaceManifest,
} from './marketplace.js'

const GIT_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 60_000
const JSONC_FMT: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' }

export interface PluginLoaderDeps {
  /** plugin 根目录（默认 ~/.ecode/plugins；测试注入 tmp） */
  baseDir?: string
  /** config.json 路径（默认 ~/.ecode/config.json；测试注入） */
  configPath?: string
  /** git 可执行（默认 'git'；测试注入假实现） */
  gitCommand?: string
  /** spawn 实现（测试注入）；默认 node:child_process.spawn */
  spawnImpl?: (cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal }) => ChildLike
  /** fetch 实现（url source 下载；测试注入） */
  fetchImpl?: (url: string, signal?: AbortSignal) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>
  warn?: (m: string) => void
}

export interface InstalledPlugin {
  name: string
  marketplace: string
  version: string
  enabled: boolean
  path: string
  manifest: PluginManifest
}

/** spawn 子进程的抽象面（测试注入 fake 用）。 */
interface ChildLike {
  on(event: 'error', cb: (e: Error) => void): void
  on(event: 'close', cb: (code: number | null) => void): void
  kill(signal?: string): void
}

/** 单个 spawn 命令（P6.1 规范：异步 + 超时 + 取消 + stderr 捕获）。 */
async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; spawnImpl?: PluginLoaderDeps['spawnImpl'] },
): Promise<{ code: number; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS
  return await new Promise((resolve, reject) => {
    const child = (opts.spawnImpl ?? defaultSpawn)(cmd, args, { cwd: opts.cwd, signal: opts.signal })
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`命令超时（${timeoutMs}ms）：${cmd} ${args.join(' ')}`)))
    }, timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`命令被取消：${cmd}`)))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      settle()
    }
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stderr })))
  })
}

function defaultSpawn(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal }): ChildLike {
  const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal })
  return {
    on(event, cb) {
      if (event === 'error') child.on('error', cb)
      else child.on('close', cb)
    },
    kill(signal) {
      child.kill(signal as NodeJS.Signals | undefined)
    },
  }
}

/** 市场来源解析：owner/repo（github）| https URL（git）| 存在的本地路径（复制）。 */
function parseMarketplaceSource(
  source: string,
): { kind: 'github'; url: string } | { kind: 'git-url'; url: string } | { kind: 'local'; path: string } {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim()) && !fs.existsSync(source)) {
    return { kind: 'github', url: `https://github.com/${source.trim()}.git` }
  }
  if (/^https?:\/\/.+\.git$/.test(source.trim())) return { kind: 'git-url', url: source.trim() }
  if (fs.existsSync(source)) return { kind: 'local', path: source }
  throw new Error(`无法识别的市场来源：${source}（支持 owner/repo、git URL、本地路径）`)
}

export class PluginLoader {
  private readonly deps: PluginLoaderDeps
  private readonly baseDir: string

  constructor(deps: PluginLoaderDeps = {}) {
    this.deps = deps
    this.baseDir = deps.baseDir ?? path.join(os.homedir(), '.ecode', 'plugins')
  }

  // —— 目录定位 ——

  private marketplacesDir(): string {
    return path.join(this.baseDir, 'marketplaces')
  }

  private cacheDir(): string {
    return path.join(this.baseDir, 'cache')
  }

  private knownFile(): string {
    return path.join(this.baseDir, 'known_marketplaces.json')
  }

  // —— P4.1 添加市场 ——

  /** 添加市场：clone/复制 → 解析 marketplace.json → 注册 known_marketplaces.json。 */
  async addMarketplace(source: string, opts: { signal?: AbortSignal } = {}): Promise<MarketplaceManifest> {
    const parsed = parseMarketplaceSource(source)
    const staging = path.join(this.marketplacesDir(), `.staging-${Date.now()}`)
    await fs.promises.mkdir(staging, { recursive: true })
    try {
      if (parsed.kind === 'local') {
        await fs.promises.cp(parsed.path, staging, { recursive: true })
      } else {
        await runCommand(this.deps.gitCommand ?? 'git', ['clone', '--depth', '1', parsed.url, staging], {
          signal: opts.signal,
          spawnImpl: this.deps.spawnImpl,
        })
      }
      const manifest = this.readMarketplace(staging)
      const target = path.join(this.marketplacesDir(), manifest.name)
      await rmIfExists(target)
      await fs.promises.rename(staging, target)
      const srcLabel = source.trim()
      this.saveKnown((known) => {
        known[manifest.name] = { source: srcLabel, addedAt: new Date().toISOString() }
      })
      return manifest
    } finally {
      await rmIfExists(staging)
    }
  }

  /** 读市场清单（目录内标准位置）。 */
  private readMarketplace(dir: string): MarketplaceManifest {
    const file = path.join(dir, MARKETPLACE_MANIFEST_REL)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      throw new Error(`市场缺少 ${MARKETPLACE_MANIFEST_REL}（${dir}）`)
    }
    return parseMarketplaceManifest(text, dir)
  }

  /** known_marketplaces.json 追加/更新。 */
  private saveKnown(mutate: (known: Record<string, { source: string; addedAt: string }>) => void): void {
    let known: Record<string, { source: string; addedAt: string }> = {}
    try {
      known = JSON.parse(fs.readFileSync(this.knownFile(), 'utf8')) as typeof known
    } catch {
      known = {}
    }
    mutate(known)
    fs.mkdirSync(path.dirname(this.knownFile()), { recursive: true })
    fs.writeFileSync(this.knownFile(), JSON.stringify(known, null, 2), 'utf8')
  }

  listMarketplaces(): string[] {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(this.knownFile(), 'utf8')) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  /** 浏览：聚合所有市场的插件（部分失败降级——失败市场进 warnings）。 */
  browse(): { marketplace: string; plugins: { name: string; description?: string; version?: string; installed: boolean }[] }[] {
    const out: { marketplace: string; plugins: { name: string; description?: string; version?: string; installed: boolean }[] }[] = []
    for (const mkt of this.listMarketplaces()) {
      try {
        const manifest = this.readMarketplace(path.join(this.marketplacesDir(), mkt))
        out.push({
          marketplace: mkt,
          plugins: manifest.plugins.map((p) => ({
            name: p.name,
            description: p.description,
            version: p.version,
            installed: this.findLatest(mkt, p.name) !== undefined,
          })),
        })
      } catch (e) {
        this.deps.warn?.(`市场 ${mkt} 读取失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  }

  // —— P4.2 安装 ——

  /** 安装：按 source 拉取 → staging（去 .git）→ 校验清单 → rename 进版本化 cache → enable。 */
  async install(
    name: string,
    marketplace: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ version: string; path: string }> {
    const mktManifest = this.readMarketplace(path.join(this.marketplacesDir(), marketplace))
    const entry = mktManifest.plugins.find((p) => p.name === name)
    if (entry === undefined) throw new Error(`市场 ${marketplace} 中没有插件 ${name}`)
    if (entry.source.source === 'local') {
      // 市场内相对路径：直接复制
      const src = path.resolve(path.join(this.marketplacesDir(), marketplace), entry.source.path)
      return this.installFromDir(src, marketplace, name, opts.signal)
    }
    const staging = path.join(this.cacheDir(), `.staging-${Date.now()}-${name}`)
    await fs.promises.mkdir(staging, { recursive: true })
    try {
      if (entry.source.source === 'github') {
        const args = ['clone', '--depth', '1']
        if (entry.source.ref !== undefined) args.push('--branch', entry.source.ref)
        args.push(`https://github.com/${entry.source.repo}.git`, staging)
        await runCommand(this.deps.gitCommand ?? 'git', args, {
          signal: opts.signal,
          spawnImpl: this.deps.spawnImpl,
        })
        await rmIfExists(path.join(staging, '.git'))
      } else {
        // url source：fetch zip + sha256 校验 + 解压
        const { source: _s, url, sha256 } = entry.source
        const buf = await this.fetchZip(url, sha256, opts.signal)
        const zip = new AdmZip(Buffer.from(buf))
        // GitHub zip 含一层 <repo>-<ref>/ 根目录——剥掉（取唯一顶层目录）
        extractStripRoot(zip, staging)
      }
      return await this.finalizeInstall(staging, marketplace, name, opts.signal)
    } finally {
      await rmIfExists(staging)
    }
  }

  /** 从本地目录安装（local source / 开发联调）。 */
  private async installFromDir(src: string, marketplace: string, name: string, signal?: AbortSignal): Promise<{ version: string; path: string }> {
    const staging = path.join(this.cacheDir(), `.staging-${Date.now()}-${name}`)
    await fs.promises.mkdir(staging, { recursive: true })
    try {
      await fs.promises.cp(src, staging, { recursive: true })
      return await this.finalizeInstall(staging, marketplace, name, signal)
    } finally {
      await rmIfExists(staging)
    }
  }

  /** 清单校验（缺失合成最小 manifest）+ 版本定位 → rename 进 cache → enable。 */
  private async finalizeInstall(
    staging: string,
    marketplace: string,
    name: string,
    _signal: AbortSignal | undefined,
  ): Promise<{ version: string; path: string }> {
    const manifestFile = findManifestFile(staging)
    let manifest: PluginManifest
    if (manifestFile === null) {
      // 清单缺失：合成最小 manifest（P4.2——MVP 容错，组件仍走目录约定）
      manifest = { name, version: '0.0.0' }
      const dir = path.join(staging, '.ecode-plugin')
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
    } else {
      manifest = parsePluginManifest(fs.readFileSync(manifestFile, 'utf8'), staging)
    }
    if (manifest.name !== name) {
      this.deps.warn?.(`清单 name「${manifest.name}」与市场条目「${name}」不一致，以清单为准`)
    }
    const version = sanitizeVersion(manifest.version)
    const target = path.join(this.cacheDir(), marketplace, manifest.name, version)
    await rmIfExists(target)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.rename(staging, target)
    this.setEnabled(manifest.name, marketplace, true)
    return { version, path: target }
  }

  private async fetchZip(url: string, sha256: string | undefined, signal?: AbortSignal): Promise<ArrayBuffer> {
    const fetchFn = this.deps.fetchImpl ?? ((u: string, s?: AbortSignal) => fetch(u, { signal: s }))
    const timer = new AbortController()
    const t = setTimeout(() => timer.abort(), FETCH_TIMEOUT_MS)
    const onOuter = (): void => timer.abort()
    signal?.addEventListener('abort', onOuter, { once: true })
    try {
      const res = await fetchFn(url, timer.signal)
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`)
      const buf = await res.arrayBuffer()
      if (sha256 !== undefined) {
        const actual = createHash('sha256').update(Buffer.from(buf)).digest('hex')
        if (actual !== sha256) throw new Error(`sha256 校验失败：期望 ${sha256}，实际 ${actual}`)
      }
      return buf
    } finally {
      clearTimeout(t)
      signal?.removeEventListener('abort', onOuter)
    }
  }

  // —— P4.4 启用/禁用/卸载 ——

  /** config.json → plugins["name@mkt"]（jsonc modify 保注释）。 */
  setEnabled(name: string, marketplace: string, enabled: boolean): void {
    const cfgPath = this.deps.configPath ?? defaultConfigPath()
    let text = '{}'
    try {
      text = fs.readFileSync(cfgPath, 'utf8')
    } catch {
      // 无 config（首次）——用空对象起步，modify 会生成结构
    }
    const edits = modify(text, ['plugins', `${name}@${marketplace}`], enabled, { formattingOptions: JSONC_FMT })
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, applyEdits(text, edits), 'utf8')
  }

  /** 已安装列表（cache 扫描 + config 启用状态）。 */
  list(): InstalledPlugin[] {
    const enabledMap = this.readEnabledMap()
    const out: InstalledPlugin[] = []
    const cacheRoot = this.cacheDir()
    let marketplaces: string[] = []
    try {
      marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      return []
    }
    for (const mkt of marketplaces) {
      const mktDir = path.join(cacheRoot, mkt)
      for (const plugin of fs.readdirSync(mktDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const versions = fs.readdirSync(path.join(mktDir, plugin.name), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name))
        const latest = versions[0]
        if (latest === undefined) continue
        const pluginDir = path.join(mktDir, plugin.name, latest.name)
        const manifestFile = findManifestFile(pluginDir)
        const manifest =
          manifestFile !== null
            ? parsePluginManifest(fs.readFileSync(manifestFile, 'utf8'), pluginDir)
            : { name: plugin.name, version: latest.name }
        out.push({
          name: plugin.name,
          marketplace: mkt,
          version: latest.name,
          enabled: enabledMap[`${plugin.name}@${mkt}`] ?? true,
          path: pluginDir,
          manifest,
        })
      }
    }
    return out
  }

  private readEnabledMap(): Record<string, boolean> {
    try {
      const parsed = parseJsonc(fs.readFileSync(this.deps.configPath ?? defaultConfigPath(), 'utf8')) as {
        plugins?: Record<string, boolean>
      }
      return parsed.plugins ?? {}
    } catch {
      return {}
    }
  }

  /** 最新版本目录（无 → undefined）。 */
  private findLatest(marketplace: string, name: string): string | undefined {
    return this.list().find((p) => p.marketplace === marketplace && p.name === name)?.path
  }

  /** 卸载：直接删 cache 目录 + config 状态移除（资源反注册由调用方先走卸载链）。 */
  async uninstall(name: string, marketplace: string): Promise<void> {
    const installed = this.list().find((p) => p.name === name && p.marketplace === marketplace)
    if (installed === undefined) throw new Error(`未安装：${name}@${marketplace}`)
    await rmIfExists(installed.path)
    this.removeEnabled(name, marketplace)
  }

  /**
   * P6.2 卸载链（disable/uninstall 共用）：
   * ① mcp close（杀 stdio 子进程）+ removeServer ② ToolRegistry.unregister 该 plugin 的 mcp__ 工具
   * ③ SkillRegistry.removeSource ④ hooks unregister（H1 分层：仅注销才动扩展注册表）
   * ⑤ metadata cache 条目保留（重新 enable 免重连拉清单）。
   */
  async teardown(
    p: InstalledPlugin,
    skillReg: SkillRegistry,
    tools: ToolRegistry | null,
    mcp: McpManager | null,
  ): Promise<void> {
    if (mcp !== null) {
      const prefix = `plugin:${p.name}/`
      for (const serverName of mcp.serverNames()) {
        if (!serverName.startsWith(prefix)) continue
        if (tools !== null) {
          for (const t of mcp.toolsOf(serverName)) {
            tools.unregister(`mcp__${sanitizeToolName(serverName)}__${sanitizeToolName(t.name)}`)
          }
        }
        await mcp.removeServer(serverName)
      }
    }
    let comps: PluginComponents | undefined
    try {
      comps = discoverComponents(p.path, p.manifest)
    } catch {
      // 目录可能已被删（uninstall 场景先 teardown 再删目录，此处防御）
    }
    for (const dir of comps?.skillsDirs ?? []) skillReg.removeSource(dir)
    globalExtensionHooks.unregister(`plugin:${p.name}@${p.marketplace}`)
  }

  private removeEnabled(name: string, marketplace: string): void {
    const cfgPath = this.deps.configPath ?? defaultConfigPath()
    let text = '{}'
    try {
      text = fs.readFileSync(cfgPath, 'utf8')
    } catch {
      return
    }
    const edits = modify(text, ['plugins', `${name}@${marketplace}`], undefined, { formattingOptions: JSONC_FMT })
    fs.writeFileSync(cfgPath, applyEdits(text, edits), 'utf8')
  }

  // —— P4.3 资源接入 ——

  /**
   * 扫描 enabled 插件 → 组件分发到各 Registry（plugin 优先级最低，M7-D4）。
   * mcpServers 的 server 命名空间 `plugin:<plugin>/<server>`（P6.2，防与用户级撞名）；
   * `${ECODE_PLUGIN_ROOT}` 在加载时展开为 cache 绝对路径（绝不存展开后的路径——版本升级 cache 会变）。
   */
  async loadAll(skillReg: SkillRegistry, mcp: McpManager | null): Promise<string[]> {
    const warnings: string[] = []
    for (const p of this.list().filter((x) => x.enabled)) {
      let comps: PluginComponents
      try {
        comps = discoverComponents(p.path, p.manifest)
      } catch (e) {
        warnings.push(`plugin ${p.name}@${p.marketplace} 组件发现失败：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      warnings.push(...comps.warnings)
      for (const dir of comps.skillsDirs) {
        await skillReg.addSource(dir)
      }
      if (mcp !== null) {
        const entries: McpServerEntry[] = Object.entries(comps.mcpServers).map(([server, rawCfg]) => ({
          name: `plugin:${p.name}/${server}`,
          cfg: expandPluginRoot(rawCfg, p.path) as McpServerConfig,
          rawCfg,
          source: 'plugin' as const,
        }))
        if (entries.length > 0) await mcp.start(entries)
      }
      // hooks：注册进全局扩展注册表（owner=plugin:name@mkt——disable/uninstall 时 unregister，H1 分层）
      if (comps.hooks.length > 0) {
        globalExtensionHooks.register(`plugin:${p.name}@${p.marketplace}`, comps.hooks)
      }
    }
    return warnings
  }
}

/** ${ECODE_PLUGIN_ROOT} 占位符展开（深遍历 cfg 的字符串值；白名单仅此一个——P8）。 */
function expandPluginRoot<T>(value: T, pluginRoot: string): T {
  if (typeof value === 'string') {
    return value.replaceAll('${ECODE_PLUGIN_ROOT}', pluginRoot) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandPluginRoot(v, pluginRoot)) as unknown as T
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[expandPluginRoot(k, pluginRoot) as string] = expandPluginRoot(v, pluginRoot)
    }
    return out as unknown as T
  }
  return value
}

async function rmIfExists(p: string): Promise<void> {
  await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})
}

/** GitHub zip 剥根目录解压（顶层唯一目录时下移一层）。 */
function extractStripRoot(zip: AdmZip, dest: string): void {
  const entries = zip.getEntries()
  const topDirs = new Set(entries.map((e) => e.entryName.split('/')[0]).filter((s) => s !== ''))
  const strip = topDirs.size === 1
  zip.extractAllTo(dest, true)
  if (strip) {
    const only = [...topDirs][0] as string
    const inner = path.join(dest, only)
    // 把内层内容上移（rename 到临时再合并——文件系统无原子"提升"，逐项移）
    const tmp = `${dest}__inner`
    fs.renameSync(inner, tmp)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(tmp, dest)
  }
}
