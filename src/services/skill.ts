/**
 * Skill 系统（M6 S-P1）：发现/解析/去重/install 双模式。
 *
 * Skill = 目录 name/SKILL.md（YAML frontmatter + markdown body）+ 可选附属文件。
 * 三层渐进加载（S1）：metadata 进 system prompt（S-P4 listing），body 由 SkillTool 按需换出。
 * 双触发面（S4）：LLM 自动调 SkillTool（listForPrompt 过滤 disableModelInvocation）；
 * 用户 /name args 手动调（listForCompletion 过滤 !userInvocable，分流在 InputStream）。
 *
 * 本模块只做确定性逻辑（解析/合并/落盘），不发起 LLM 请求、不弹 UI——
 * 蒸馏的 LLM merger 与预览交互在命令层（skill/distill.ts）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import AjvImport from 'ajv'
import type { ValidateFunction } from 'ajv'

/** ajv 实例的鸭子类型（NodeNext default interop，同 tools/registry.ts）。 */
type AjvInstance = { compile: (schema: object) => ValidateFunction }
const Ajv =
  (AjvImport as unknown as { default?: new (o: object) => AjvInstance }).default ??
  (AjvImport as unknown as new (o: object) => AjvInstance)

// —— 常量（S3.2 校验规则）——
export const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const MAX_NAME_LEN = 64
const MAX_DESC_LEN = 1024
/** versions 备份上限（S8.3：安全网不是版本管理，超限淘汰最旧）。 */
const MAX_VERSIONS = 10
/** versions 目录内单条备份的 section 合并结果落盘名。 */
const SKILL_FILE = 'SKILL.md'

export interface SkillInfo {
  name: string
  /** 清单展示用（原始值，截断在 listing 层做） */
  description: string
  whenToUse?: string
  /** markdown 正文（去 frontmatter） */
  body: string
  /** skill 目录绝对路径（附属文件相对它，SkillTool 注入给 LLM） */
  baseDir: string
  source: 'user' | 'project' | 'plugin'
  /** 默认 true；false 不进 / 补全（仅 LLM 可调） */
  userInvocable: boolean
  /** 默认 false；true 不进 LLM 清单（仅手动） */
  disableModelInvocation: boolean
}

/** 起草/升级的产物契约（distill 命令层产出，install 消费）。 */
export interface SkillCandidate {
  name: string
  description: string
  whenToUse?: string
  userInvocable?: boolean
  disableModelInvocation?: boolean
  body: string
}

/** 升级模式的 section 裁决：keep=保留现有（丢弃补丁段）/ adopt=采用新（整体替换）。 */
export interface SectionDecision {
  title: string
  verdict: 'keep' | 'adopt'
}

export type InstallResult =
  | { mode: 'created'; path: string }
  /** conflicts = 被替换的同名 section 标题（供命令层/UI 展示） */
  | { mode: 'upgraded'; path: string; backedUpTo: string; conflicts: string[] }

/** frontmatter 原始解析结果（字段名保留下划线/连字符原样， AJV 校验前转 camelCase）。 */
type RawFrontmatter = Record<string, string>

const frontmatterSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: SKILL_NAME_RE.source, minLength: 1, maxLength: MAX_NAME_LEN },
    description: { type: 'string', minLength: 1, maxLength: MAX_DESC_LEN },
    when_to_use: { type: 'string' },
    'user-invocable': { type: 'boolean' },
    'disable-model-invocation': { type: 'boolean' },
  },
  required: ['name', 'description'],
  // 未知字段忽略（前向兼容）
} as const

/** 解析单份 SKILL.md 文本 → { frontmatter, body }；无 frontmatter 返回空对象 + 全文 body。 */
export function parseSkillMd(text: string): { fm: RawFrontmatter; body: string } {
  // 中段 `([\s\S]*?)\r?\n?---` 允许空 frontmatter（---\n---\n 紧贴）
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: text }
  const fm: RawFrontmatter = {}
  for (const line of m[1].split(/\r?\n/)) {
    // 极简扁平 YAML：只认 `key: value` 单行（skill frontmatter 不需要嵌套结构）
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '')
    if (value !== '') fm[kv[1]] = value
  }
  return { fm, body: m[2].replace(/^\r?\n/, '') }
}

/** 单行 YAML 值序列化（换行折叠成空格，防 frontmatter 结构破坏）。 */
function fmValue(s: string): string {
  const flat = s.replace(/\s*\r?\n\s*/g, ' ').trim()
  return flat.includes(':') ? `"${flat.replace(/"/g, "'")}"` : flat
}

/** SkillCandidate → SKILL.md 文本（install 落盘用）。 */
export function serializeSkillMd(c: SkillCandidate): string {
  const lines = ['---', `name: ${c.name}`, `description: ${fmValue(c.description)}`]
  if (c.whenToUse !== undefined && c.whenToUse !== '') lines.push(`when_to_use: ${fmValue(c.whenToUse)}`)
  if (c.userInvocable === false) lines.push('user-invocable: false')
  if (c.disableModelInvocation === true) lines.push('disable-model-invocation: true')
  lines.push('---', '', c.body.trimEnd(), '')
  return lines.join('\n')
}

/** body 按 `## ` 二级标题切段（S8.3 section 合并的边界定义）。 */
export interface BodySections {
  /** 首个 ## 之前的内容（标题/引言） */
  preamble: string
  sections: { title: string; text: string }[] // text 含标题行，到下一个 ## 前
}

export function splitSections(body: string): BodySections {
  const lines = body.split(/\r?\n/)
  const preambleLines: string[] = []
  const sections: { title: string; text: string }[] = []
  let current: string[] | null = null
  let currentTitle = ''
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) {
      if (current !== null) sections.push({ title: currentTitle, text: current.join('\n') })
      currentTitle = h[1].trim()
      current = [line]
    } else if (current !== null) {
      current.push(line)
    } else {
      preambleLines.push(line)
    }
  }
  if (current !== null) sections.push({ title: currentTitle, text: current.join('\n') })
  return { preamble: preambleLines.join('\n').trim(), sections }
}

/**
 * section 级确定性合并（S8.3）：同名 section 整体替换、新 section 追加到末尾、
 * keep 裁决的补丁段丢弃。纯函数可完整单测；LLM 只产出判定，永不拼盘。
 */
export function mergeBody(existingBody: string, patchBody: string, decisions: SectionDecision[] = []): string {
  const keep = new Set(decisions.filter((d) => d.verdict === 'keep').map((d) => d.title))
  const old = splitSections(existingBody)
  const patch = splitSections(patchBody)
  const oldByTitle = new Map(old.sections.map((s) => [s.title, s]))
  const patchByTitle = new Map(patch.sections.map((s) => [s.title, s]))
  // 保留现有顺序：旧 section 就地替换（未被 keep 跳过的同名补丁）
  const merged = old.sections.map((s) => (patchByTitle.has(s.title) && !keep.has(s.title) ? patchByTitle.get(s.title)! : s))
  // 补丁里有而旧 body 没有的（且未被 keep——keep 一个不存在的段等于丢弃）追加到末尾
  for (const s of patch.sections) {
    if (!oldByTitle.has(s.title) && !keep.has(s.title)) merged.push(s)
  }
  const preamble = patch.preamble !== '' ? patch.preamble : old.preamble
  return [preamble, ...merged.map((s) => s.text.trim())].filter((t) => t !== '').join('\n\n') + '\n'
}

/** Registry 可注入的目录配置（测试传 tmp 目录；默认工厂用真实路径）。 */
export interface SkillRegistryDirs {
  /** 项目级（高优先）；undefined = 无项目级源 */
  projectDir?: string
  /** 用户级 */
  userDir: string
}

export interface SkillLoadOpts {
  /** 内置命令名列表（撞名检测：skill 名遮蔽 → warn + 补全标记，S4.1 v6） */
  builtinCommandNames?: string[]
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillInfo>()
  /** 优先级降序的源目录列表（load 时固化） */
  private sourceDirs: { dir: string; source: SkillInfo['source'] }[] = []
  /** 与内置命令撞名的 skill（补全里加「被命令遮蔽」标记） */
  readonly shadowedByCommand = new Set<string>()
  /** 加载期警告（解析失败跳过/撞名；makeDeps 转发 LogStore） */
  readonly loadWarnings: string[] = []
  private readonly validateFm: ValidateFunction

  constructor(private readonly dirs: SkillRegistryDirs) {
    const ajv = new Ajv({ allErrors: true }) as unknown as AjvInstance
    this.validateFm = ajv.compile(frontmatterSchema as object)
  }

  /** 启动扫描：项目级 > 用户级 > addSource 追加的 plugin 级；realpath + name 去重，首个胜出。 */
  async load(opts: SkillLoadOpts = {}): Promise<void> {
    this.skills.clear()
    this.loadWarnings.length = 0
    this.shadowedByCommand.clear()
    this.sourceDirs = []
    if (this.dirs.projectDir !== undefined) {
      this.sourceDirs.push({ dir: this.dirs.projectDir, source: 'project' })
    }
    this.sourceDirs.push({ dir: this.dirs.userDir, source: 'user' })
    // 项目级向上遍历到 home：取最近的 .ecode/skills（更具体的目录优先）
    if (this.dirs.projectDir === undefined) {
      const found = findProjectSkillsDir(process.cwd())
      if (found !== undefined) this.sourceDirs.unshift({ dir: found, source: 'project' })
    }
    for (const src of this.sourceDirs) {
      await this.scanDir(src.dir, src.source)
    }
    // 撞名检测（v6）：skill 名与内置命令同名 → 内置优先分流（S4.4），此处只 warn + 标记
    for (const name of this.skills.keys()) {
      if (opts.builtinCommandNames?.includes(name)) {
        this.shadowedByCommand.add(name)
        this.loadWarnings.push(`skill「${name}」与内置命令同名，/补全与手动触发将被命令优先遮蔽（建议改名）`)
      }
    }
  }

  private async scanDir(dir: string, source: SkillInfo['source']): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在/不可读：静默（无 skill 源是常态）
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const baseDir = path.join(dir, entry.name)
      const file = path.join(baseDir, SKILL_FILE)
      let text: string
      try {
        text = await fs.promises.readFile(file, 'utf8')
      } catch {
        continue // 无 SKILL.md 的目录不是 skill
      }
      const info = this.parse(baseDir, entry.name, text, source)
      if (info === undefined) continue
      if (this.skills.has(info.name)) {
        this.loadWarnings.push(`skill「${info.name}」重复（${baseDir} 被已有来源遮蔽）`)
        continue // 首个胜出（优先级由 sourceDirs 顺序保证）
      }
      this.skills.set(info.name, info)
    }
  }

  /** 单份解析：frontmatter 抽取 + 回退（name→目录名 / description→body 首段）+ AJV 校验。 */
  private parse(baseDir: string, dirName: string, text: string, source: SkillInfo['source']): SkillInfo | undefined {
    const { fm, body } = parseSkillMd(text)
    const data: Record<string, unknown> = {
      name: fm['name'] ?? dirName,
      description: fm['description'] ?? firstParagraph(body),
      ...(fm['when_to_use'] !== undefined ? { when_to_use: fm['when_to_use'] } : {}),
      ...(fm['user-invocable'] !== undefined ? { 'user-invocable': fm['user-invocable'] === 'true' } : {}),
      ...(fm['disable-model-invocation'] !== undefined
        ? { 'disable-model-invocation': fm['disable-model-invocation'] === 'true' }
        : {}),
    }
    if (!this.validateFm(data)) {
      this.loadWarnings.push(`skill「${dirName}」frontmatter 非法（${baseDir}），已跳过`)
      return undefined
    }
    return {
      name: data['name'] as string,
      description: data['description'] as string,
      whenToUse: (data['when_to_use'] as string | undefined) || undefined,
      body,
      baseDir: baseDir.split(path.sep).join('/'),
      source,
      userInvocable: (data['user-invocable'] as boolean | undefined) ?? true,
      disableModelInvocation: (data['disable-model-invocation'] as boolean | undefined) ?? false,
    }
  }

  /** M7 plugin 目录注入口（M6 不调用但接口冻结：load 后追加源再扫）。 */
  async addSource(dir: string): Promise<void> {
    this.sourceDirs.push({ dir, source: 'plugin' })
    await this.scanDir(dir, 'plugin')
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name)
  }

  /** 全量（含 disableModelInvocation 的——手动面要用）。 */
  list(): SkillInfo[] {
    return [...this.skills.values()]
  }

  /** LLM 清单（S4.2 system prompt 用）。 */
  listForPrompt(): SkillInfo[] {
    return this.list().filter((s) => !s.disableModelInvocation)
  }

  /** / 补全与手动触发面（S4.4 InputStream 用）。 */
  listForCompletion(): SkillInfo[] {
    return this.list().filter((s) => s.userInvocable)
  }

  /**
   * 创建/升级唯一落盘入口（S8.3）：同名已存在 → 升级模式
   * （versions 备份 → frontmatter 整体采用新值 → body section 级合并）。
   * 只做确定性落盘；merger 判定与预览/裁决交互在命令层。
   */
  async install(c: SkillCandidate, decisions: SectionDecision[] = []): Promise<InstallResult> {
    if (!SKILL_NAME_RE.test(c.name) || c.name.length > MAX_NAME_LEN) {
      throw new Error(`skill 名非法：${c.name}（须匹配 ${SKILL_NAME_RE.source}，≤${MAX_NAME_LEN} 字符）`)
    }
    if (c.description.trim() === '' || c.description.length > MAX_DESC_LEN) {
      throw new Error(`description 不能为空且 ≤${MAX_DESC_LEN} 字符`)
    }
    const targetDir = path.join(this.dirs.userDir, c.name)
    const targetFile = path.join(targetDir, SKILL_FILE)
    await fs.promises.mkdir(targetDir, { recursive: true })
    const existing = this.skills.get(c.name)
    if (existing === undefined) {
      await fs.promises.writeFile(targetFile, serializeSkillMd(c), 'utf8')
      const info = this.parse(targetDir, c.name, serializeSkillMd(c), 'user')
      if (info !== undefined) this.skills.set(c.name, info)
      return { mode: 'created', path: targetFile.split(path.sep).join('/') }
    }
    // —— 升级模式 ——
    const backedUpTo = await this.backupVersion(existing)
    const oldBody = existing.body
    const newBody = mergeBody(oldBody, c.body, decisions)
    const merged: SkillCandidate = { ...c, body: newBody }
    await fs.promises.writeFile(targetFile, serializeSkillMd(merged), 'utf8')
    const conflicts = replacedTitles(oldBody, c.body, decisions)
    const info = this.parse(targetDir, c.name, serializeSkillMd(merged), existing.source)
    if (info !== undefined) this.skills.set(c.name, info)
    return { mode: 'upgraded', path: targetFile.split(path.sep).join('/'), backedUpTo, conflicts }
  }

  /** 当前 SKILL.md 存档到 versions/vN/（上限 MAX_VERSIONS，超出挤掉最旧）。 */
  private async backupVersion(existing: SkillInfo): Promise<string> {
    const versionsDir = path.join(existing.baseDir, 'versions')
    await fs.promises.mkdir(versionsDir, { recursive: true })
    let nums: number[]
    try {
      nums = (await fs.promises.readdir(versionsDir))
        .map((d) => Number(d.match(/^v(\d+)$/)?.[1]))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b)
    } catch {
      nums = []
    }
    const next = (nums.at(-1) ?? 0) + 1
    const destDir = path.join(versionsDir, `v${next}`)
    await fs.promises.mkdir(destDir, { recursive: true })
    await fs.promises.copyFile(path.join(existing.baseDir, SKILL_FILE), path.join(destDir, SKILL_FILE))
    // 超限淘汰最旧
    while (nums.length + 1 > MAX_VERSIONS) {
      const oldest = nums.shift()
      if (oldest === undefined) break
      await fs.promises.rm(path.join(versionsDir, `v${oldest}`), { recursive: true, force: true })
    }
    return destDir.split(path.sep).join('/')
  }

  /** 测试隔离（对齐 CommandRegistry.clear 先例）。 */
  clear(): void {
    this.skills.clear()
    this.sourceDirs = []
    this.loadWarnings.length = 0
    this.shadowedByCommand.clear()
  }
}

/** 被替换的同名 section 标题（install 升级反馈）。 */
function replacedTitles(existingBody: string, patchBody: string, decisions: SectionDecision[]): string[] {
  const keep = new Set(decisions.filter((d) => d.verdict === 'keep').map((d) => d.title))
  const oldTitles = new Set(splitSections(existingBody).sections.map((s) => s.title))
  return splitSections(patchBody)
    .sections.filter((s) => oldTitles.has(s.title) && !keep.has(s.title))
    .map((s) => s.title)
}

function firstParagraph(body: string): string {
  const t = body.trim()
  if (t === '') return ''
  return t.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? ''
}

/** 从 start 向上找最近的 `<dir>/.ecode/skills`（到 home 停；项目级源探测）。 */
export function findProjectSkillsDir(start: string): string | undefined {
  const home = os.homedir()
  let dir = path.resolve(start)
  for (;;) {
    const candidate = path.join(dir, '.ecode', 'skills')
    if (fs.existsSync(candidate)) return candidate
    if (dir === home || path.dirname(dir) === dir) return undefined
    dir = path.dirname(dir)
  }
}

/** 默认工厂（真实路径；cli makeDeps 用）。 */
export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry({ userDir: path.join(os.homedir(), '.ecode', 'skills') })
}

/** 全局单例（skillTool 闭包引用，与 commandRegistry 一致）。 */
export const skillRegistry = createSkillRegistry()

/**
 * 手动触发展开（S4.4）：body + 参数 → 注入用全文。
 * 两条规则保证任何 skill 都不丢参：
 *   ① body 含 $ARGUMENTS → 替换为参数文本
 *   ② 不含 → 兜底追加 `ARGUMENTS: ...`（没写占位符的 skill 也能接参）
 * 未传参 → 剥掉残留占位符（防字面 $ARGUMENTS 进上下文）。
 * 返回的是完整 user 消息文本（<skill_content> 包裹 + baseDir 附注）。
 */
export function expandSkill(info: SkillInfo, args?: string): string {
  let body = info.body
  if (args !== undefined && args.trim() !== '') {
    body = body.includes('$ARGUMENTS')
      ? body.replaceAll('$ARGUMENTS', args)
      : `${body}\n\nARGUMENTS: ${args}`
  } else {
    body = body.replaceAll('$ARGUMENTS', '')
  }
  return [
    `<skill_content name="${info.name}">`,
    body.trim(),
    '',
    `该 Skill 附属文件目录：${info.baseDir}（相对路径基于此目录，需要时用 read_file 读取）。`,
    '</skill_content>',
  ].join('\n')
}
