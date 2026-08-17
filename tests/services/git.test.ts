/** git 轻量集成测（M9-P6）：tmpdir 真 git 仓库（TEST_GIT_ENV 注入 identity）。 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 全量并发下 git 子进程慢（M9 问题清单已知项）：本文件放宽超时，根治偶发
vi.setConfig({ testTimeout: 60_000 }) // 全量并发饥饿偶发（单跑恒绿）；CI 化时 --no-file-parallelism 根治
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
  }, 20_000)

  it('终审 P1-2：用户已 staged 的文件不混入 ECode 提交；/undo 不清掉用户改动', async () => {
    await initRepo()
    await configIdentity()
    writeFileSync(join(dir, 'mine.txt'), 'user work')
    writeFileSync(join(dir, 'a.ts'), 'A')
    await execFileAsync('git', ['add', 'mine.txt'], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } }) // 用户手动 staged
    const r = await ecodeCommit(dir, 'sess-1', [join(dir, 'a.ts')], 'ecode: 改 a')
    expect(r.committed).toBe(true)
    // ECode 提交只含 a.ts
    const show = await execFileAsync('git', ['show', '--stat', '--format='], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } })
    expect(show.stdout).toContain('a.ts')
    expect(show.stdout).not.toContain('mine.txt')
    // /undo 后用户 staged/工作区改动保留
    const u = await undoEcodeCommit(dir)
    expect(u.ok).toBe(true)
    const st = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir, env: { ...process.env, ...TEST_GIT_ENV } })
    expect(st.stdout).toContain('mine.txt') // 用户的东西还在
    expect(readFileSync(join(dir, 'mine.txt'), 'utf8')).toBe('user work')
  }, 20_000)

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

  it('中文文件名（tracked）：/undo 完整恢复——quotepath 转义不解析', async () => {
    await initRepo()
    await configIdentity()
    writeFileSync(join(dir, '文档.md'), 'v1')
    await userCommit('user init')
    writeFileSync(join(dir, '文档.md'), 'v2')
    const c = await ecodeCommit(dir, 'sess-1', [join(dir, '文档.md')], 'ecode: 改文档')
    expect(c.committed).toBe(true)
    const u = await undoEcodeCommit(dir)
    expect(u.ok).toBe(true)
    expect(readFileSync(join(dir, '文档.md'), 'utf8')).toBe('v1')
  }, 20_000)

  it('中文文件名（新建）：/undo 删除 ECode 新建的文件', async () => {
    await initRepo()
    await configIdentity()
    writeFileSync(join(dir, '新建.md'), 'new')
    const c = await ecodeCommit(dir, 'sess-1', [join(dir, '新建.md')], 'ecode: 新建')
    expect(c.committed).toBe(true)
    const u = await undoEcodeCommit(dir)
    expect(u.ok).toBe(true)
    expect(existsSync(join(dir, '新建.md'))).toBe(false)
  }, 20_000)

  it('commit 失败：add 的 stage 回滚，index 不残留', async () => {
    await initRepo()
    await configIdentity()
    // 失败诱因用 pre-commit hook（exit 1）——无 identity 在有全局配置的机器上造不出失败
    const hooks = join(dir, 'hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n')
    await execFileAsync('git', ['config', 'core.hooksPath', hooks], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'A')
    const r = await ecodeCommit(dir, 'sess-1', [join(dir, 'a.ts')], 'ecode: 改')
    expect(r.committed).toBe(false)
    // 修复前：add 已执行、commit 失败不清理 → 'A  a.ts' 残留在用户 index
    const st = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir, env: { ...process.env, TEST_GIT_ENV } })
    expect(st.stdout).toContain('?? a.ts') // 回到 untracked（?? hooks/ 是本测试自造的 hook 目录）
    expect(st.stdout).not.toContain('A  a.ts')
  }, 20_000)
})
