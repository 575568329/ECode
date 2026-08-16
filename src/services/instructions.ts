/**
 * 指令文件注入（M8 §1，M8-D2）：用户级 + 项目级两级指令进 system prompt。
 *
 * 命名：ECODE.md 为主、项目级 CLAUDE.md 兼容回退（每层先 ECODE.md 再 CLAUDE.md，
 * Claude 生态存量指令直接可用）；用户级只认 ~/.ecode/ECODE.md（自家地盘无需兼容）。
 * 两级分工：用户级 = 跨项目个人偏好（先注入）；项目级 = repo 约定（后注入，
 * 语义上更具体的覆盖更泛的）。
 * 边界：findUp 首个命中即止（不叠加多层）；边界同 skill 的 findUpDir
 * （home 停、非 home 树收最近 git 根）——避免两套边界漂移。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findUpDir } from './skill.js'
import { readClampedFile } from './readClamped.js'

/** 单级上限（32KB）：注入在 system 内，天然计入压缩估算。 */
const MAX_INSTRUCTION_BYTES = 32 * 1024

export interface InstructionBlock {
  /** 来源标注（'用户级 ~/.ecode/ECODE.md' / '项目级 <path>'） */
  source: string
  content: string
  /** 截断标记（M8：启动时聚合给用户底部提示——自己写的指令没全生效需可知） */
  truncated?: boolean
}

export interface LoadInstructionsOpts {
  cwd?: string
  /** 用户级文件路径（默认 ~/.ecode/ECODE.md；测试注入） */
  userFile?: string
  /** 单级上限字节（默认 32KB；config maxInstructionsKB 可调） */
  maxBytes?: number
}

/**
 * 读两级指令（读盘是启动/submit 期同步行为——buildSystemPrompt 是同步函数，
 * 32KB×2 的 readFileSync 与 config 加载同级，非热路径）。
 * 返回 [用户级, 项目级]（缺失的级别跳过——两级都无文件返回空数组，零注入）。
 */
export function loadInstructions(opts: LoadInstructionsOpts = {}): InstructionBlock[] {
  const blocks: InstructionBlock[] = []
  const cwd = opts.cwd ?? process.cwd()
  const maxBytes = opts.maxBytes ?? MAX_INSTRUCTION_BYTES

  const userFile = opts.userFile ?? path.join(os.homedir(), '.ecode', 'ECODE.md')
  const user = readClamped(userFile, maxBytes)
  if (user !== undefined) {
    blocks.push({ source: '用户级 ~/.ecode/ECODE.md', content: user.text, ...(user.truncated ? { truncated: true } : {}) })
  }

  const projectFile = findProjectInstructionFile(cwd)
  if (projectFile !== undefined) {
    const project = readClamped(projectFile, maxBytes)
    if (project !== undefined) {
      blocks.push({ source: `项目级 ${projectFile.split(path.sep).join('/')}`, content: project.text, ...(project.truncated ? { truncated: true } : {}) })
    }
  }
  return blocks
}

/** 项目级指令文件：findUp 每层先 ECODE.md 再 CLAUDE.md，首个命中即止。 */
export function findProjectInstructionFile(cwd: string): string | undefined {
  const dir = findUpDir(cwd, (d) => fs.existsSync(path.join(d, 'ECODE.md')) || fs.existsSync(path.join(d, 'CLAUDE.md')))
  if (dir === undefined) return undefined
  const ecode = path.join(dir, 'ECODE.md')
  return fs.existsSync(ecode) ? ecode : path.join(dir, 'CLAUDE.md')
}

/** 读文件 + 上限截断（尾注原文路径与提示，防静默丢指令）。缺文件/读失败返回 undefined。 */
function readClamped(file: string, maxBytes: number): { text: string; truncated?: boolean } | undefined {
  const r = readClampedFile(file, maxBytes)
  if (r === undefined) return undefined
  if (!r.truncated) return { text: r.text }
  return {
    truncated: true,
    text: `${r.text}\n\n[已截断：原文超出 ${maxBytes} 上限，完整内容用 read_file 读取 ${file.split(path.sep).join('/')}]`,
  }
}

/** 拼注入段（空块返回 ''——调用方判空零开销）。 */
export function renderInstructions(blocks: InstructionBlock[]): string {
  if (blocks.length === 0) return ''
  return blocks
    .map((b) => `--- 指令（${b.source}）---\n${b.content.trim()}`)
    .join('\n\n')
}
