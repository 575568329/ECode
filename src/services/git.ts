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

/** sessionId 形态（cli 生成处 = `new Date().toISOString().replace(/[:.]/g, '-')`）：
 *  形如 2026-08-20T12-34-56-789Z。trailer 值合法性校验用——防提交正文恰好出现
 *  "Ecode-Commit: " 字样被误判（安全审阅 P2：误判即 /undo reset 用户提交）。 */
const SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/**
 * trailer 段判定（导出供单测）：提交信息**最后一个段落**中存在整行
 * `Ecode-Commit: <合法 sessionId 形态>` 才算 ECode 提交。
 * 三重收紧：① 只看最后段落（git trailer 惯例——ecodeCommit 用第二个 -m 生成独立段落）；
 * ② 整行精确前缀匹配（正文行内夹带字样不算）；③ 值必须匹配 sessionId 形态。
 */
export function hasEcodeTrailer(body: string): boolean {
  const paragraphs = body.replace(/\r\n/g, '\n').trimEnd().split(/\n[ \t]*\n/)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  for (const line of last.split('\n')) {
    const m = /^Ecode-Commit:[ \t](\S+)$/.exec(line.trim())
    if (m !== null && SESSION_ID_RE.test(m[1] as string)) return true
  }
  return false
}

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
  // 写入侧卫语句：trailer 值非法（/undo 读取侧只认合法形态）会产生无法识别的提交——读写对称
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new TypeError(`ecodeCommit: sessionId 形态非法（应为 ISO 时间戳变换形态）：${sessionId}`)
  }
  try {
    await git(cwd, ['add', '--', ...files])
    // 终审 P1-2：pathspec --only——只提交指定路径。裸 commit 提交整个 index，会混入用户
    // 手动 staged 的文件；且 /undo 的 reset --hard 会把那些改动一并清掉（违反"绝不动用户的东西"）。
    await git(cwd, ['commit', '--only', '-m', subject, '-m', `${ECODE_TRAILER_PREFIX}${sessionId}`, '--', ...files])
    return { committed: true }
  } catch (e) {
    // add 已执行而 commit 失败 → 本轮 add 的 stage 退回（尽力而为，回滚失败不掩盖原始错误）。
    // 极端场景（用户此前 staged 过同名文件）其 staged 版本一并退回 HEAD——工作区无损。
    await git(cwd, ['reset', '-q', '--', ...files]).catch(() => {})
    return { committed: false, reason: `git commit 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 最近一次提交是否 ECode 提交（trailer 段精确校验，hasEcodeTrailer）；顺带返回 subject。 */
export async function lastCommitIsEcode(cwd: string): Promise<{ isEcode: boolean; subject: string }> {
  try {
    const body = await git(cwd, ['log', '-1', '--format=%B'])
    const subject = body.split('\n')[0] ?? ''
    return { isEcode: hasEcodeTrailer(body), subject }
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
    const files = (await git(cwd, ['-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD'])).split('\n').map((l) => l.trim()).filter(Boolean)
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
