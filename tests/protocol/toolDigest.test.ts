/** 活动流 B2：makeToolDigest 单源规则（宿主/web/TUI 三方共用——净化+截断出口）。 */
import { describe, it, expect } from 'vitest'
import { makeToolDigest } from '../../src/protocol/toolDigest.js'

describe('makeToolDigest（活动流 §4/P1-1）', () => {
  it('bash → command 首行', () => {
    expect(makeToolDigest('bash', { command: 'npx vitest run 2>&1 | tail -5' })).toBe('npx vitest run 2>&1 | tail -5')
  })

  it('command 多行只取首行（heredoc 不刷屏）', () => {
    expect(makeToolDigest('bash', { command: "cat > /tmp/x <<'EOF'\nline2\nline3" })).toBe("cat > /tmp/x <<'EOF'")
  })

  it('read_file/glob/grep → 路径或 pattern 字段', () => {
    expect(makeToolDigest('read_file', { path: 'src/tui/App.tsx' })).toBe('src/tui/App.tsx')
    expect(makeToolDigest('grep', { pattern: 'PromptResult', path_glob: 'src/**/*.ts' })).toBe('PromptResult')
    expect(makeToolDigest('web_search', { query: 'ink static resize' })).toBe('ink static resize')
  })

  it('未知工具/空入参 → name 兜底', () => {
    expect(makeToolDigest('mcp__x__y', {})).toBe('mcp__x__y')
    expect(makeToolDigest('task', undefined)).toBe('task')
  })

  it('转义序列净化（OSC 52 剪贴板覆写不可达终端——生成即 strip）', () => {
    expect(makeToolDigest('bash', { command: 'echo \x1b]52;c;base64\x07payload' })).not.toContain('\x1b')
    expect(makeToolDigest('bash', { command: 'ls \x1b[2J clear' })).toBe('ls  clear')
  })

  it('按显示宽度截 60 列（CJK 占 2 列，恒单物理行）', () => {
    const digest = makeToolDigest('bash', { command: '一'.repeat(80) })
    expect(digest.endsWith('…')).toBe(true)
    // 60 列上限 = 59 个全角字符宽 + …（宽度 1）——总显示宽 ≤ 60
    expect(digest.length).toBeLessThanOrEqual(61)
  })
})
