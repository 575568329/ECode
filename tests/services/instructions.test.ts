import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findProjectInstructionFile,
  loadInstructions,
  renderInstructions,
} from '../../src/services/instructions.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ecode-instr-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function touch(rel: string, content = 'x'): Promise<string> {
  const f = path.join(tmpRoot, rel)
  await mkdir(path.dirname(f), { recursive: true })
  await writeFile(f, content, 'utf8')
  return f
}

describe('loadInstructions（两级注入）', () => {
  it('两级都有 → [用户级, 项目级] 顺序（用户级先）', async () => {
    await touch('proj/ECODE.md', 'project rules')
    const blocks = loadInstructions({ cwd: path.join(tmpRoot, 'proj'), userFile: path.join(tmpRoot, 'user', 'ECODE.md') })
    // userFile 未创建 → 只有项目级；补用户级再验顺序
    expect(blocks).toHaveLength(1)
    await touch('user/ECODE.md', 'user prefs')
    const both = loadInstructions({ cwd: path.join(tmpRoot, 'proj'), userFile: path.join(tmpRoot, 'user', 'ECODE.md') })
    expect(both.map((b) => b.content)).toEqual(['user prefs', 'project rules'])
    expect(both[0]?.source).toContain('用户级')
    expect(both[1]?.source).toContain('项目级')
  })

  it('两级都无 → 空数组（零注入零开销）', () => {
    expect(loadInstructions({ cwd: tmpRoot, userFile: path.join(tmpRoot, 'none.md') })).toEqual([])
  })

  it('项目级 ECODE.md 优先 CLAUDE.md（同层两者都在）', async () => {
    await touch('proj/ECODE.md', 'ecode one')
    await touch('proj/CLAUDE.md', 'claude one')
    const blocks = loadInstructions({ cwd: path.join(tmpRoot, 'proj'), userFile: path.join(tmpRoot, 'none.md') })
    expect(blocks[0]?.content).toBe('ecode one')
  })

  it('只有 CLAUDE.md → 回退读取（兼容存量）', async () => {
    await touch('proj/CLAUDE.md', 'claude only')
    const blocks = loadInstructions({ cwd: path.join(tmpRoot, 'proj'), userFile: path.join(tmpRoot, 'none.md') })
    expect(blocks[0]?.content).toBe('claude only')
  })

  it('findUp 子目录命中父层文件（首个命中即止，不叠加多层）', async () => {
    await touch('root/CLAUDE.md', 'root')
    await touch('root/ECODE.md', 'root-ecode')
    await touch('root/sub/deep/ECODE.md', 'deep')
    // sub 无 → 命中 root 层（ECODE.md 优先）
    expect(findProjectInstructionFile(path.join(tmpRoot, 'root', 'sub'))?.endsWith('ECODE.md')).toBe(true)
    const blocks = loadInstructions({ cwd: path.join(tmpRoot, 'root', 'sub'), userFile: path.join(tmpRoot, 'none.md') })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).toBe('root-ecode')
    // deep 自己有 → 只取 deep（首命中即止）
    const deep = loadInstructions({ cwd: path.join(tmpRoot, 'root', 'sub', 'deep'), userFile: path.join(tmpRoot, 'none.md') })
    expect(deep[0]?.content).toBe('deep')
  })

  it('超 32KB 截断 + 尾注原文路径', async () => {
    const big = 'x'.repeat(33 * 1024)
    const f = await touch('proj/ECODE.md', big)
    const blocks = loadInstructions({ cwd: path.join(tmpRoot, 'proj'), userFile: path.join(tmpRoot, 'none.md') })
    expect(blocks[0]?.content).toContain('[已截断')
    expect(blocks[0]?.content).toContain(f.split(path.sep).join('/'))
    expect(Buffer.byteLength(blocks[0]?.content ?? '', 'utf8')).toBeLessThanOrEqual(33 * 1024)
  })
})

describe('renderInstructions', () => {
  it('空块 → 空串', () => {
    expect(renderInstructions([])).toBe('')
  })
  it('来源标注分段', () => {
    const out = renderInstructions([{ source: '用户级 ~/.ecode/ECODE.md', content: 'a' }])
    expect(out).toContain('--- 指令（用户级 ~/.ecode/ECODE.md）---')
    expect(out).toContain('a')
  })
})
