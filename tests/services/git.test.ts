/** git 轻量集成测（M9-P6）：tmpdir 真 git 仓库（TEST_GIT_ENV 注入 identity）。 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ecodeCommit, lastCommitIsEcode, undoEcodeCommit, isGitRepo, TEST_GIT_ENV } from '../../src/services/git.js'

const execFileAsync = promisify(execFile)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecode-git-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function initRepo(): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } })
}

async function userCommit(msg: string): Promise<void> {
  await execFileAsync('git', ['add', '.'], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } })
  await execFileAsync('git', ['commit', '-m', msg], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } })
}

/** git.ts 内部 execFile 未透传 env——identity 靠仓库级 local config 注入（模拟用户已配置） */
async function configIdentity(): Promise<void> {
  await execFileAsync('git', ['config', 'user.email', 'u@t'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'u'], { cwd: dir })
}

describe('git 轻量集成（M9-P6）', () => {
  it('非 git 仓库：isGitRepo false / commit 与 undo 容错', async () => {
    expect(await isGitRepo(dir)).toBe(false)
    const c = await ecodeCommit(dir, 's1', [join(dir, 'a.ts')], 'msg')
    expect(c.committed).toBe(false)
    const u = await undoEcodeCommit(dir)
    expect(u.ok).toBe(false)
  })

  it('ecodeCommit：trailer 落盘 + 只 add 指定文件', async () => {
    await initRepo()
    await configIdentity()
    writeFileSync(join(dir, 'mine.txt'), 'user file')
    await userCommit('init')
    writeFileSync(join(dir, 'a.ts'), 'A')
    writeFileSync(join(dir, 'b.ts'), 'B')
    const r = await ecodeCommit(dir, 'sess-1', [join(dir, 'a.ts')], 'ecode: 改 a')
    expect(r.committed).toBe(true)
    const last = await lastCommitIsEcode(dir)
    expect(last.isEcode).toBe(true)
    expect(last.subject).toBe('ecode: 改 a')
    // b.ts 未被 add（用户工作区保持未暂存）
    const st = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
    expect(st.stdout.trim()).toBe('?? b.ts')
  })

  it('/undo：ECode 提交可撤销（文件还原到提交前）；用户提交拒绝', async () => {
    await initRepo()
    await configIdentity()
    writeFileSync(join(dir, 'a.ts'), 'v1')
    await userCommit('user init')
    writeFileSync(join(dir, 'a.ts'), 'v2')
    const c = await ecodeCommit(dir, 'sess-1', [join(dir, 'a.ts')], 'ecode: v2')
    expect(c.committed).toBe(true)
    const u = await undoEcodeCommit(dir)
    expect(u.ok).toBe(true)
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('v1') // 文件还原
    expect((await lastCommitIsEcode(dir)).subject).toBe('user init')
    // 再 undo：最近是用户提交 → 拒绝
    const u2 = await undoEcodeCommit(dir)
    expect(u2.ok).toBe(false)
    expect(u2.message).toContain('拒绝撤销')
  }, 20_000)
})
