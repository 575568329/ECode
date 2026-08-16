/**
 * git 轻量集成（M9-P6 / D5/D6）：autoCommit（默认 false，显式开）+ /undo 安全撤销。
 *
 * 哲学：不静默改用户 repo——autoCommit 默认关；/undo 只回退带 Ecode-Commit trailer 的
 * 最近一次提交（绝不动用户自己的提交）。
 *
 * trailer 约定：commit message 第二段落 `Ecode-Commit: <sessionId>`（git 多 -m 生成段落，
 * log --format=%B 读取校验）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const ECODE_TRAILER_PREFIX = 'Ecode-Commit: '

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env })
  return stdout
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

export interface CommitOutcome {
  committed: boolean
  /** 未提交/非仓库/无改动的原因（提示用） */
  reason?: string
}

/**
 * ECode 自动提交：git add <files> + commit（message 两段：摘要行 + Ecode-Commit trailer）。
 * 只 add 指定文件（不碰用户其他改动）；commit 失败（无 identity 等）如实返回 reason。
 */
export async function ecodeCommit(cwd: string, sessionId: string, files: string[], subject: string): Promise<CommitOutcome> {
  if (files.length === 0) return { committed: false, reason: '本轮无文件改动' }
  if (!(await isGitRepo(cwd))) return { committed: false, reason: '非 git 仓库' }
  try {
    await git(cwd, ['add', '--', ...files])
    await git(cwd, ['commit', '-m', subject, '-m', `${ECODE_TRAILER_PREFIX}${sessionId}`])
    return { committed: true }
  } catch (e) {
    return { committed: false, reason: `git commit 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 最近一次提交是否 ECode 提交（trailer 校验）；顺带返回 subject。 */
export async function lastCommitIsEcode(cwd: string): Promise<{ isEcode: boolean; subject: string }> {
  try {
    const body = await git(cwd, ['log', '-1', '--format=%B'])
    const subject = body.split('\n')[0] ?? ''
    return { isEcode: body.includes(ECODE_TRAILER_PREFIX), subject }
  } catch {
    return { isEcode: false, subject: '' }
  }
}

export interface UndoOutcome {
  ok: boolean
  message: string
}

/**
 * /undo：只对带 Ecode-Commit trailer 的最近提交生效——git reset --hard HEAD~1
 * （提交与文件一并回退，"文件还原"语义；前置 trailer 强校验，用户自己的提交一律拒绝）。
 */
export async function undoEcodeCommit(cwd: string): Promise<UndoOutcome> {
  if (!(await isGitRepo(cwd))) return { ok: false, message: '非 git 仓库，无法撤销' }
  const last = await lastCommitIsEcode(cwd)
  if (!last.isEcode) {
    return { ok: false, message: `最近一次提交不是 ECode 创建的（${last.subject || '（无提交）'}），拒绝撤销——绝不回退用户自己的提交。文件回退可用 /rewind。` }
  }
  try {
    await git(cwd, ['reset', '--hard', 'HEAD~1'])
    return { ok: true, message: `已撤销 ECode 提交「${last.subject}」（文件已还原到该提交前；如需撤销更多可用 /rewind）` }
  } catch (e) {
    return { ok: false, message: `git reset 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 供测试注入 identity（真实环境用用户 git config） */
export const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'ecode-test',
  GIT_AUTHOR_EMAIL: 'ecode@test.local',
  GIT_COMMITTER_NAME: 'ecode-test',
  GIT_COMMITTER_EMAIL: 'ecode@test.local',
}
