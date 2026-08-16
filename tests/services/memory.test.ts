import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadMemoryIndexes, renderMemory } from '../../src/services/memory.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ecode-memory-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function writeMem(rel: string, content: string): Promise<string> {
  const f = path.join(tmpRoot, rel)
  await mkdir(path.dirname(f), { recursive: true })
  await writeFile(f, content, 'utf8')
  return f
}

describe('loadMemoryIndexes', () => {
  it('两级都有 → 用户级先、项目级后', async () => {
    const userFile = await writeMem('user/MEMORY.md', '- [全局偏好](a.md) — 用中文')
    await writeMem('proj/.ecode/memory/MEMORY.md', '- [测试](t.md) — vitest')
    const idx = loadMemoryIndexes({ cwd: path.join(tmpRoot, 'proj'), userFile })
    expect(idx.map((m) => m.level)).toEqual(['user', 'project'])
    expect(idx[1]?.content).toContain('vitest')
  })

  it('缺文件/缺目录/空文件 → 静默跳过（无 memory 是常态）', () => {
    expect(loadMemoryIndexes({ cwd: tmpRoot, userFile: path.join(tmpRoot, 'none.md') })).toEqual([])
  })

  it('超 32KB 截断', async () => {
    const userFile = await writeMem('user/MEMORY.md', 'x'.repeat(33 * 1024))
    const idx = loadMemoryIndexes({ cwd: tmpRoot, userFile })
    expect(idx[0]?.content).toContain('[已截断')
  })
})

describe('renderMemory', () => {
  it('空 → 空串', () => {
    expect(renderMemory([])).toBe('')
  })

  it('含行为指引（按需读 topic 文件 + 维护指引）', () => {
    const out = renderMemory([{ level: 'project', content: '- [测试](t.md) — vitest' }])
    expect(out).toContain('--- 记忆索引 ---')
    expect(out).toContain('read_file')
    expect(out).toContain('项目级记忆')
    expect(out).toContain('vitest')
  })
})

describe('项目级 findUp（与指令注入同语义，M8 补充①）', () => {
  it('子目录启动命中父层 MEMORY.md（首个命中即止）', async () => {
    const userFile = path.join(tmpRoot, 'none.md')
    await writeMem('root/.ecode/memory/MEMORY.md', '- [根](r.md) — 根级')
    const idx = loadMemoryIndexes({ cwd: path.join(tmpRoot, 'root', 'sub'), userFile })
    expect(idx).toHaveLength(1)
    expect(idx[0]?.content).toContain('根级')
  })
  it('子目录自己的 MEMORY.md 优先（更具体的覆盖）', async () => {
    const userFile = path.join(tmpRoot, 'none.md')
    await writeMem('root/.ecode/memory/MEMORY.md', '- [根](r.md) — 根级')
    await writeMem('root/sub/.ecode/memory/MEMORY.md', '- [子](s.md) — 子级')
    const idx = loadMemoryIndexes({ cwd: path.join(tmpRoot, 'root', 'sub'), userFile })
    expect(idx).toHaveLength(1)
    expect(idx[0]?.content).toContain('子级')
  })
})
