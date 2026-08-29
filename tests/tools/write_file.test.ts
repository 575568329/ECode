/** write_file 结果 diff 测（2026-08-29 用户拍板「改动必须显示全量 diff」——覆盖已有文件时
 *  结果附带完整 unified diff；新文件/内容未变化保持一行）。临时目录，不碰真实用户目录。 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileTool } from '../../src/tools/builtin/write_file.js'

async function inTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ecode-wft-'))
}

const tool = writeFileTool

describe('write_file 结果 diff', () => {
  it('新文件：一行结果，无 diff 标记', async () => {
    const dir = await inTmp()
    try {
      const r = await tool.execute({ path: 'new.txt', content: 'a\nb\n' }, { cwd: dir })
      expect(r.is_error).toBeUndefined()
      expect(r.content).toContain('已写入 new.txt（3 行）')
      expect(r.content).not.toContain('---')
      expect(r.content).not.toContain('+++')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('覆盖已有文件：结果附完整 unified diff（-旧行/+新行，中段不折叠）', async () => {
    const dir = await inTmp()
    try {
      await writeFile(join(dir, 'exist.txt'), 'old-1\nold-2\nold-3\n', 'utf8')
      const r = await tool.execute({ path: 'exist.txt', content: 'old-1\nnew-2\nnew-3\n' }, { cwd: dir })
      expect(r.is_error).toBeUndefined()
      expect(r.content).toContain('覆盖')
      expect(r.content).toContain('-old-2')
      expect(r.content).toContain('+new-2')
      expect(r.content).toContain('-old-3')
      expect(r.content).toContain('+new-3')
      // 盘上内容确实被覆盖
      expect(await readFile(join(dir, 'exist.txt'), 'utf8')).toBe('old-1\nnew-2\nnew-3\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('内容未变化：一行结果明示，不附空 diff', async () => {
    const dir = await inTmp()
    try {
      await writeFile(join(dir, 'same.txt'), 'x\ny\n', 'utf8')
      const r = await tool.execute({ path: 'same.txt', content: 'x\ny\n' }, { cwd: dir })
      expect(r.content).toContain('内容未变化')
      expect(r.content).not.toContain('---')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
