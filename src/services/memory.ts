/**
 * auto-memory 索引注入（M8 §3，M8-D6）：两级 MEMORY.md 索引进 system prompt 动态段。
 *
 * 零新基建：存储就是普通 markdown 文件——MEMORY.md 是索引（一行一条
 * `- [主题](文件名.md) — 一句话钩子`），topic 文件（同目录 *.md）由模型按需
 * read_file（不预载）；维护用现有 write_file/edit_file（无新工具无新权限面）。
 * memory 在 system 不进 messages → 不受压缩影响、不进 HistoryStore（边界清晰）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findUpDir } from './skill.js'

const MAX_MEMORY_BYTES = 32 * 1024

export interface LoadMemoryOpts {
  cwd?: string
  userFile?: string
  /** 单级上限字节（默认 32KB；config maxInstructionsKB 可调） */
  maxBytes?: number
}

/**
 * 读两级 MEMORY.md（用户级 ~/.ecode/memory/MEMORY.md 先、项目级 .ecode/memory/MEMORY.md 后）。
 * 只注入索引文件全文；缺文件/缺目录静默（无 memory 是常态）。
 */
export function loadMemoryIndexes(opts: LoadMemoryOpts = {}): { level: 'user' | 'project'; content: string; truncated?: boolean }[] {
  const out: { level: 'user' | 'project'; content: string; truncated?: boolean }[] = []
  const cwd = opts.cwd ?? process.cwd()
  const maxBytes = opts.maxBytes ?? MAX_MEMORY_BYTES
  // 项目级 findUp 首个命中（与指令注入同语义——用户自建多级目录时取最近的，
  // 不叠加不做多级全读；边界同 findUpDir：home 停、非 home 树收 git 根）
  const projectDir = findUpDir(cwd, (d) => fs.existsSync(path.join(d, '.ecode', 'memory', 'MEMORY.md')))
  const files: { level: 'user' | 'project'; file: string }[] = [
    { level: 'user', file: opts.userFile ?? path.join(os.homedir(), '.ecode', 'memory', 'MEMORY.md') },
    ...(projectDir !== undefined ? [{ level: 'project' as const, file: path.join(projectDir, '.ecode', 'memory', 'MEMORY.md') }] : []),
  ]
  for (const { level, file } of files) {
    const r = readClampedFast(file, maxBytes)
    if (r === undefined) continue
    const trimmed = r.text.trim()
    if (trimmed === '') continue
    const bytes = Buffer.byteLength(trimmed, 'utf8')
    const truncated = r.truncated === true || bytes > maxBytes
    out.push({
      level,
      ...(truncated ? { truncated: true } : {}),
      content: truncated
        ? `${trimmed.slice(0, maxBytes)}\n[已截断：原文超出 ${maxBytes} 上限]`
        : trimmed,
    })
  }
  return out
}

/** 拼注入段（含行为指引——模型看到索引知道该按需读 topic 文件）。 */
export function renderMemory(indexes: { level: 'user' | 'project'; content: string }[]): string {
  if (indexes.length === 0) return ''
  const parts = indexes.map((m) => `【${m.level === 'user' ? '用户级偏好' : '项目级记忆'}】\n${m.content}`)
  return [
    '--- 记忆索引 ---',
    '以下是长期记忆的索引（主题文件在同目录，需要细节时用 read_file 读取对应文件；发现值得长期记住的用户偏好/项目约定时，按同格式追加进对应 MEMORY.md 并把细节写入主题文件）。',
    ...parts,
  ].join('\n')
}

/**
 * stat 先行读取（M8 补充交付③）：先 stat 判大小——超上限只读上限字节（超大误写文件
 * 不整读进内存，总字节数从 stat 取，供截断提示与 truncated 判定）。
 * 注入场景必须有总大小（截断提示"原文 N 字节"），流式逐块反而拿不到；上限字节读取
 * 用定位读（open + read），正常几 KB 文件与 readFileSync 等价。
 */
function readClampedFast(file: string, maxBytes: number): { text: string; truncated?: boolean } | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return undefined
  }
  if (stat.size <= maxBytes) {
    try {
      return { text: fs.readFileSync(file, 'utf8') }
    } catch {
      return undefined
    }
  }
  // 超限：只定位读上限字节（总大小语义由 stat 提供——不整读超大误写文件进内存）
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const read = fs.readSync(fd, buf, 0, maxBytes, 0)
    return { truncated: true, text: buf.subarray(0, read).toString('utf8') }
  } finally {
    fs.closeSync(fd)
  }
}
