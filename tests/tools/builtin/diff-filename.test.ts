/**
 * F-05：edit_file / preview diff 中文文件名八进制转义回归锁。
 * jsdiff createTwoFilesPatch 对非 ASCII 文件名生成 `"\350\257\246..."` 八进制转义 header
 * （且新版 jsdiff 的 timestamp 缺省值会打出 `[object Object]` 尾巴）。
 * 修法：patch 生成后对 ---/+++ header 行解码还原。本测试锁行为：中文路径 diff 输出可读。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editFileTool } from '../../../src/tools/builtin/edit_file.js'
import { buildPreview } from '../../../src/services/preview.js'
import type { ToolContext } from '../../../src/tools/interface.js'

let tmpDir: string
let ctx: ToolContext

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ecode-diffname-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal }
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('F-05 diff 中文文件名可读', () => {
  it('edit_file：平级中文文件名 diff header 可读', async () => {
    writeFileSync(join(tmpDir, '配置.md'), 'a\nb\n')
    const r = await editFileTool.execute(
      { path: '配置.md', oldString: 'b', newString: 'c' },
      ctx,
    )
    expect(r.is_error).toBeFalsy()
    const out = String(r.content)
    expect(out).toContain('配置.md')
    expect(out).not.toMatch(/\\3[0-9]{2}/) // 无八进制转义残骸
    expect(out).not.toContain('[object Object]')
    expect(out).toMatch(/^--- 配置\.md$/m)
    expect(out).toMatch(/^\+\+\+ 配置\.md$/m)
  })

  it('previewEdit：中文路径审批 diff header 可读', async () => {
    writeFileSync(join(tmpDir, '配置.md'), 'a\nb\n')
    const diff = await buildPreview(
      {
        id: 'toolu_1',
        name: 'edit_file',
        input: { path: '配置.md', oldString: 'b', newString: 'c' },
      } as never,
      tmpDir,
    )
    expect(diff).toContain('--- 配置.md')
    expect(diff).toContain('+++ 配置.md')
    expect(diff).not.toMatch(/\\3[0-9]{2}/)
    expect(diff).not.toContain('[object Object]')
  })

  it('ASCII 路径行为不变', async () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'a\nb\n')
    const r = await editFileTool.execute(
      { path: 'a.txt', oldString: 'b', newString: 'c' },
      ctx,
    )
    expect(String(r.content)).toMatch(/^\+\+\+ a\.txt$/m)
  })
})
