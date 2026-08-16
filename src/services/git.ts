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
    // 终审 P1-2：pathspec --only——只提交指定路径。裸 commit 提交整个 index，会混入用户
    // 手动 staged 的文件；且 /undo 的 reset --hard 会把那些改动一并清掉（违反"绝不动用户的东西"）。
    await git(cwd, ['commit', '--only', '-m', subject, '-m', `${ECODE_TRAILER_PREFIX}${sessionId}`, '--', ...files])
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
 * /undo：只对带 Ecode-Commit trailer 的最近提交生效，且只回退**该提交自己的文件集**——
 * reset --soft 撤销提交（不动 index/worktree）+ 对提交内每个文件恢复旧内容（HEAD 有→checkout；
 * HEAD 无=新建→rm）。绝不碰用户 staged/工作区的其他改动（终审 P1-2：--hard 会把用户 staged
 * 文件一并清掉）。用户自己的提交一律拒绝（trailer 强校验）。
 */
export async function undoEcodeCommit(cwd: string): Promise<UndoOutcome> {
  if (!(await isGitRepo(cwd))) return { ok: false, message: '非 git 仓库，无法撤销' }
  const last = await lastCommitIsEcode(cwd)
  if (!last.isEcode) {
    return { ok: false, message: `最近一次提交不是 ECode 创建的（${last.subject || '（无提交）'}），拒绝撤销——绝不回退用户自己的提交。文件回退可用 /rewind。` }
  }
  try {
    const files = (await git(cwd, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').map((l) => l.trim()).filter(Boolean)
    // 首个提交（无父）不能 reset HEAD~1——update-ref -d 回到无提交态（index/worktree 不动）
    const hasParent = await git(cwd, ['rev-parse', '--verify', 'HEAD~1'])
      .then(() => true)
      .catch(() => false)
    if (hasParent) {
      await git(cwd, ['reset', '--soft', 'HEAD~1'])
      for (const f of files) {
        const inOldHead = await git(cwd, ['cat-file', '-e', `HEAD:${f}`])
          .then(() => true)
          .catch(() => false)
        if (inOldHead) await git(cwd, ['checkout', 'HEAD', '--', f]) // 从 HEAD 恢复 index+worktree（裸 checkout -- 只回 index，soft 后 index 仍是新内容）
        else await git(cwd, ['rm', '-f', '--', f]) // ECode 新建的文件：撤销=删除
      }
    } else {
      await git(cwd, ['update-ref', '-d', 'HEAD'])
      for (const f of files) await git(cwd, ['rm', '-f', '--', f]) // 首个提交里的 ECode 文件=新建，撤销=删除
    }
    return { ok: true, message: `已撤销 ECode 提交「${last.subject}」（其文件已还原到提交前；你的其他改动不受影响；如需撤销更多可用 /rewind）` }
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
