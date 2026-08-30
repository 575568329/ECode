/** W-4 diff 解析纯模块单测（批 3）：分类/头提取/无 diff 回退/截断护栏 */
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_LINES, parseDiffContent } from '../src/diffView'

const sample = '已更新 a.ts（1 处）\n\n--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n-const y = 2\n+const x = 1\n 保留行'

describe('parseDiffContent', () => {
  it('标准形态：头提取 + 行分类（file/hunk/add/del/ctx）', () => {
    const v = parseDiffContent(sample)
    expect(v).not.toBeNull()
    expect(v?.header).toBe('已更新 a.ts（1 处）')
    expect(v?.lines[0]).toEqual({ kind: 'file', text: '--- a.ts' })
    expect(v?.lines[1]).toEqual({ kind: 'file', text: '+++ a.ts' })
    expect(v?.lines[2]).toEqual({ kind: 'hunk', text: '@@ -1,2 +1,2 @@' })
    expect(v?.lines[3]).toEqual({ kind: 'del', text: '-const y = 2' })
    expect(v?.lines[4]).toEqual({ kind: 'add', text: '+const x = 1' })
    expect(v?.lines[5]).toEqual({ kind: 'ctx', text: ' 保留行' })
    expect(v?.changes).toBe(2)
    expect(v?.truncated).toBe(false)
  })

  it('空串 / 无 diff 标记 → null（调用方回退 pre）', () => {
    expect(parseDiffContent('')).toBeNull()
    expect(parseDiffContent('只是一段普通说明文本')).toBeNull()
  })

  it('超上限截断：omitted 统计 + changes 只计保留部分', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => (i % 2 === 0 ? `+新增${i}` : `  上下文${i}`)).join('\n')
    const content = `已写入 big.txt（覆盖）\n\n--- big.txt\n+++ big.txt\n${big}`
    const v = parseDiffContent(content)
    expect(v).not.toBeNull()
    expect(v?.truncated).toBe(true)
    expect(v?.omitted).toBe(52) // 2052 行正文 - 2000 保留（含 ---/+++ 两行文件头）
    expect(v?.lines.length).toBe(MAX_DIFF_LINES)
  })

  it('CRLF 归一（Windows 工具输出）', () => {
    const v = parseDiffContent('已更新 a.ts\r\n\r\n--- a.ts\r\n+++ a.ts\r\n+ok')
    expect(v?.lines.map((l) => l.text)).toEqual(['--- a.ts', '+++ a.ts', '+ok'])
  })
})
