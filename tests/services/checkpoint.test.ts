/**
 * CheckpointStore 测（M9-P1）：真实 tmpdir 文件系统（不 mock fs——布局/GC/还原语义靠真文件断言）。
 * 治理上限全部注入小值（maxPerSession/maxSessions/maxFileBytes），不造 10MB 大文件。
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckpointStore } from '../../src/services/checkpoint.js'

const execFileAsync = promisify(execFile)

let dir: string
const warn = vi.fn()

/** 每测独立 store：独立 root（会话互不污染），warn 收集可断言 */
function makeStore(opts?: { maxPerSession?: number; maxSessions?: number; maxFileBytes?: number; cwd?: string }): CheckpointStore {
  return new CheckpointStore(opts?.cwd ?? dir, {
    rootDir: join(dir, `root-${Math.random().toString(36).slice(2)}`),
    warn,
    ...opts,
  })
}

async function write(rel: string, content: string): Promise<string> {
  const p = join(dir, rel)
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content, 'utf8')
  return p
}

beforeEach(() => {
  dir = join(tmpdir(), `ecode-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('CheckpointStore：快照与 content-addressed 布局', () => {
  it('快照两文件 → objects 2 份 + meta 引用（path→hash）', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'AAA')
    const b = await write('b.ts', 'BBB')
    const seq = await store.snapshot('s1', [a, b], { tool: 'write_file' })
    expect(seq).toBe(1)
    const metas = await store.list('s1')
    expect(metas).toHaveLength(1)
    expect(metas[0]?.files.map((f) => f.path)).toEqual([a, b])
    expect(metas[0]?.tool).toBe('write_file')
    const objects = await readdir(join(await objectsDirOf(store, 's1')))
    expect(objects).toHaveLength(2)
  })

  it('同内容多轮未变只存一份（去重）', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'AAA')
    await store.snapshot('s1', [a], { tool: 'write_file' })
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    const metas = await store.list('s1')
    expect(metas).toHaveLength(2)
    expect(metas[0]?.files[0]?.hash).toBe(metas[1]?.files[0]?.hash)
    expect(await readdir(join(await objectsDirOf(store, 's1')))).toHaveLength(1)
  })

  it('不存在的新文件记 absent 基线（09-03 走查修复：新建文件可回退删除）；空 paths 返回 null', async () => {
    const store = makeStore()
    const absentPath = join(dir, 'not-exist.ts')
    const seq = await store.snapshot('s1', [absentPath], { tool: 'write_file' })
    expect(seq).not.toBeNull() // absent 也是有效基线（原 null=新建文件不可回退）
    const metas = await store.list('s1')
    expect(metas[0]?.files[0]).toMatchObject({ path: absentPath, absent: true })
    expect(await store.snapshot('s1', [], { tool: 'bash' })).toBeNull() // 空 paths（非 git cwd）=无修改集
  })

  it('absent 回退：新建文件 revert 后被删除；撤销撤销可恢复（09-03 走查回归锁）', async () => {
    const store = makeStore()
    const created = join(dir, 'created-by-agent.ts')
    // 时序：onBeforeWrite 快照（文件不存在→absent）→ 工具创建文件
    const seq1 = await store.snapshot('s1', [created], { tool: 'write_file' })
    await writeFile(created, 'agent 内容', 'utf8')
    // 回退到点1：文件应被删除
    const r = await store.revert('s1', seq1!)
    expect(r.restored).toEqual([created])
    expect(existsSync(created)).toBe(false)
    // 撤销撤销：revert 前自动快照拍下了「agent 内容」——revert 回自动点=文件恢复
    const metas = await store.list('s1')
    const auto = metas.find((m) => m.tool === 'rewind-auto')
    expect(auto).toBeDefined()
    await store.revert('s1', auto!.seq)
    expect(await readFile(created, 'utf8')).toBe('agent 内容')
  })

  it('>maxFileBytes 跳过 + warn', async () => {
    const store = makeStore({ maxFileBytes: 10 })
    const big = await write('big.ts', 'X'.repeat(50))
    await store.snapshot('s1', [big], { tool: 'write_file' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('big.ts'))
    expect(await store.list('s1')).toHaveLength(0)
  })

  it('bash 近修改集：git 仓库内 dirty 文件被快照', async () => {
    // 独立 git 仓库（git init + dirty 文件）
    const repo = join(dir, 'repo')
    await mkdir(repo)
    await execFileAsync('git', ['init'], { cwd: repo })
    await writeFile(join(repo, 'tracked.txt'), 'base')
    await execFileAsync('git', ['add', '.'], { cwd: repo })
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo })
    await writeFile(join(repo, 'tracked.txt'), 'changed')
    const store = makeStore({ cwd: repo })
    const seq = await store.snapshot('s1', [], { tool: 'bash' })
    expect(seq).toBe(1)
    const metas = await store.list('s1')
    expect(metas[0]?.files.some((f) => f.path.endsWith('tracked.txt'))).toBe(true)
  })

  it('bash 近修改集：rename 的 old 路径项无状态码前缀——不解析、不误拍撞名文件', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    await execFileAsync('git', ['init'], { cwd: repo })
    // old 项 "xyzkeepme.txt" 被错误 slice(3) 后恰为 "keepme.txt"（tracked 干净文件）——修复前会被误拍
    await writeFile(join(repo, 'xyzkeepme.txt'), 'to-rename')
    await writeFile(join(repo, 'keepme.txt'), 'innocent')
    await execFileAsync('git', ['add', '.'], { cwd: repo })
    await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo })
    await execFileAsync('git', ['mv', 'xyzkeepme.txt', 'b.txt'], { cwd: repo })
    const store = makeStore({ cwd: repo })
    await store.snapshot('s1', [], { tool: 'bash' })
    const metas = await store.list('s1')
    expect(metas[0]?.files.map((f) => f.path)).toEqual([join(repo, 'b.txt')])
  }, 20_000)

  it('bash 近修改集：非 git 仓库 → 跳过 + warn', async () => {
    const store = makeStore()
    const seq = await store.snapshot('s1', [], { tool: 'bash' })
    expect(seq).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('git'))
  })
})

describe('CheckpointStore：治理', () => {
  it('每会话点数上限：超限淘汰最旧 + 孤儿 objects 回收', async () => {
    const store = makeStore({ maxPerSession: 2 })
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'write_file' })
    await writeFile(a, 'v2')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    await writeFile(a, 'v3')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    const metas = await store.list('s1')
    expect(metas.map((m) => m.seq)).toEqual([2, 3]) // 点 1 被淘汰
    // v1 的对象只被点 1 引用 → GC 回收；v2/v3 仍被点 2/3 引用 → 保留
    const objects = await readdir(join(await objectsDirOf(store, 's1')))
    expect(objects).toHaveLength(2)
  })

  it('全局会话目录上限：超限按 mtime 淘汰最旧', async () => {
    const store = makeStore({ maxSessions: 2 })
    const a = await write('a.ts', 'A')
    await store.snapshot('old', [a], { tool: 'write_file' })
    await store.snapshot('mid', [a], { tool: 'write_file' })
    await store.snapshot('new', [a], { tool: 'write_file' })
    const root = (store as unknown as { root: string }).root
    const sessions = await readdir(root)
    expect(sessions.sort()).toEqual(['mid', 'new'])
  })
})

describe('CheckpointStore：还原', () => {
  it('逆序还原：选中点（含）及之后 → 回到该点执行前（每文件范围内最早基线）', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点1 基线 v1
    await writeFile(a, 'v2')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点2 基线 v2
    await writeFile(a, 'v3')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点3 基线 v3
    await writeFile(a, 'v4')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点4 基线 v4（真实时序：每次改动前必有快照）
    const r = await store.revert('s1', 2) // 选点2 = 回到 v2（点2执行前）
    expect(await readFile(a, 'utf8')).toBe('v2')
    expect(r.restored).toEqual([a])
    expect(r.externalChanged).toEqual([]) // 当前 v4 = 点4 基线，非外部改动
  })

  it('还原前自动快照（撤销可撤销）：revert 后存在 rewind-auto 点，再 revert 它可回到 revert 前状态', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    await writeFile(a, 'v2')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    await writeFile(a, 'v3')
    await store.revert('s1', 2) // 回到 v2
    expect(await readFile(a, 'utf8')).toBe('v2')
    // 自动点（seq=3，tool=rewind-auto，内容 v3）存在
    const metas = await store.list('s1')
    const auto = metas.find((m) => m.tool === 'rewind-auto')
    expect(auto).toBeDefined()
    expect(auto?.seq).toBe(3)
    // 撤销撤销：revert 到自动点 = 回到 v3
    await store.revert('s1', auto!.seq)
    expect(await readFile(a, 'utf8')).toBe('v3')
  })

  it('点数满时 revert：自动快照不触发治理——最旧点基线不被 GC，还原完整（终审 P1-3）', async () => {
    const store = makeStore({ maxPerSession: 3 })
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点1 基线 v1
    await writeFile(a, 'v2')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点2 基线 v2
    await writeFile(a, 'v3')
    await store.snapshot('s1', [a], { tool: 'edit_file' }) // 点3 基线 v3（已达上限）
    await writeFile(a, 'v4') // 当前 v4
    // 竞态（修复前）：自动快照成点4 → 治理淘汰点1 → GC 回收 v1 对象 → 写回点1失败，a 停在 v2
    const r = await store.revert('s1', 1)
    expect(await readFile(a, 'utf8')).toBe('v1')
    expect(r.restored).toEqual([a])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('对象缺失'))
    // 治理延迟到下次正常快照：点4（rewind-auto）仍在，可撤销撤销
    const auto = (await store.list('s1')).find((m) => m.tool === 'rewind-auto')
    expect(auto?.seq).toBe(4)
  })

  it('外部改动检测：快照后手改 → 报告；未改 → 空', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    const b = await write('b.ts', 'keep')
    await store.snapshot('s1', [a, b], { tool: 'edit_file' })
    await writeFile(a, '用户手改')
    expect(await store.detectExternalChanges('s1', 1)).toEqual([a])
    const r = await store.revert('s1', 1)
    expect(r.externalChanged).toEqual([a])
  })

  it('还原后对象缺失（手工删 objects）：warn 跳过不炸', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    await writeFile(a, 'v2') // 当前 ≠ 基线（否则自动快照会重建 v1 对象，测不到缺失路径）
    const objDir = await objectsDirOf(store, 's1')
    for (const f of await readdir(objDir)) await rm(join(objDir, f))
    const r = await store.revert('s1', 1)
    expect(r.restored).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('对象缺失'))
  })

  it('安全审阅 P2-a：对象被篡改（内容 ≠ 哈希）→ 拒绝还原（throw），目标文件零写入', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    await store.snapshot('s1', [a], { tool: 'edit_file' })
    await writeFile(a, 'v2')
    const objDir = await objectsDirOf(store, 's1')
    const obj = (await readdir(objDir))[0]!
    await writeFile(join(objDir, obj), 'tampered content')
    await expect(store.revert('s1', 1)).rejects.toThrow('哈希不符')
    expect(await readFile(a, 'utf8')).toBe('v2') // 篡改数据未写回
  })
})

describe('CheckpointStore：恢复会话跟随', () => {
  it('copyForResume：旧目录整体拷贝到新 id，新 id 可 list/还原', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'v1')
    await store.snapshot('old-session', [a], { tool: 'edit_file' })
    await store.copyForResume('old-session', 'new-session')
    const metas = await store.list('new-session')
    expect(metas).toHaveLength(1)
    await writeFile(a, 'v2')
    await store.revert('new-session', 1)
    expect(await readFile(a, 'utf8')).toBe('v1')
  })

  it('copyForResume：旧目录不存在 → 静默（新会话无历史快照不炸）', async () => {
    const store = makeStore()
    await expect(store.copyForResume('nope', 'fresh')).resolves.toBeUndefined()
  })
})

/** 拿到 store 内部 root（测试专用：经 list 的对象路径反推不可靠，直接按注入 rootDir 规则拼） */
async function objectsDirOf(store: CheckpointStore, sessionId: string): Promise<string> {
  // rootDir 是 join(dir, `root-xxx`)；通过私有字段读（as any 测试后门——避免为测试暴露 API）
  const root = (store as unknown as { root: string }).root
  return join(root, sessionId, 'objects')
}


describe('M11-P1：快照操作串行化（并发 nextSeq 竞态）', () => {
  it('并发 snapshot：seq 全部唯一递增（修复前读改写竞态可重号）', async () => {
    const store = makeStore()
    const a = await write('a.ts', 'A')
    const b = await write('b.ts', 'B')
    const c = await write('c.ts', 'C')
    const seqs = await Promise.all([
      store.snapshot('s1', [a], { tool: 'edit_file' }),
      store.snapshot('s1', [b], { tool: 'edit_file' }),
      store.snapshot('s1', [c], { tool: 'edit_file' }),
    ])
    expect(seqs.sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3])
    expect(new Set(seqs).size).toBe(3)
  })
})
