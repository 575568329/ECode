/**
 * auto-memory 索引注入（M8 §3，M8-D6）：两级 MEMORY.md 索引进 system prompt 动态段。
 *
 * 零新基建：存储就是普通 markdown 文件——MEMORY.md 是索引（一行一条
 * `- [主题](文件名.md) — 一句话钩子`），topic 文件（同目录 *.md）由模型按需
 * read_file（不预载）；维护用现有 write_file/edit_file（无新工具、无新权限面）。
 * memory 在 system 不进 messages → 不受压缩影响、不进 HistoryStore（边界清晰）。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findUpDir } from './skill.js'
import { readClampedFile } from './readClamped.js'

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
export function loadMemoryIndexes(opts: LoadMemoryOpts = {}): { level: 'user' | 'project'; dir: string; content: string; truncated?: boolean }[] {
  const out: { level: 'user' | 'project'; dir: string; content: string; truncated?: boolean }[] = []
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
    const r = readClampedFile(file, maxBytes)
    if (r === undefined) continue
    const trimmed = r.text.trim()
    if (trimmed === '') continue
    out.push({
      level,
      dir: path.dirname(file).split(path.sep).join('/'),
      ...(r.truncated ? { truncated: true } : {}),
      content: r.truncated ? `${trimmed}\n[已截断：原文超出 ${maxBytes} 上限]` : trimmed,
    })
  }
  return out
}

/**
 * 拼注入段（含行为指引——模型看到索引知道该按需读 topic 文件）。
 * 每级注入 topic 文件所在绝对目录（2026-09-02 真机实证：只说"同目录"不说在哪，
 * 模型连猜 4 种路径形态——项目相对回溯/裸相对/Git Bash 风格 /c/...——浪费 4 轮迭代+审批）。
 */
export function renderMemory(indexes: { level: 'user' | 'project'; dir?: string; content: string }[]): string {
  if (indexes.length === 0) return ''
  const parts = indexes.map((m) => {
    const where = m.dir !== undefined && m.dir !== '' ? `（文件目录 ${m.dir}/）` : ''
    return `【${m.level === 'user' ? '用户级偏好' : '项目级记忆'}】${where}\n${m.content}`
  })
  return [
    '--- 记忆索引 ---',
    '以下是长期记忆的索引（主题文件在各级标注的目录里，需要细节时用 read_file 以「目录/文件名」的绝对路径读取，不要猜路径；发现值得长期记住的用户偏好/项目约定时，按同格式追加进对应 MEMORY.md 并把细节写入主题文件）。',
    ...parts,
  ].join('\n')
}
