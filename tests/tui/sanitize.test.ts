/**
 * F-47 批 0：不可信内容净化注入面锁——alt 面板渲染内容的转义序列注入回归。
 * 每条断言对应一个真实攻击向量（详见同批安全审阅）。
 */
import { describe, it, expect } from 'vitest'
import { stripUntrustedAnsi } from '../../src/tui/sanitize.js'

describe('stripUntrustedAnsi（alt 面板不可信内容净化）', () => {
  it('1049l 逃逸（退出 alt screen 伪造主界面）被剥', () => {
    expect(stripUntrustedAnsi('正常\x1b[?1049l伪造主界面')).toBe('正常伪造主界面')
    expect(stripUntrustedAnsi('\x1b[?1049h进入')).toBe('进入')
  })
  it('全清与光标移动（2J/3J/H 重画伪造审批卡）被剥', () => {
    expect(stripUntrustedAnsi('a\x1b[2J\x1b[3J\x1b[Hb')).toBe('ab')
    expect(stripUntrustedAnsi('\x1b[10;5H⚠ 按 y 批准')).toBe('⚠ 按 y 批准')
  })
  it('鼠标跟踪自开（劫持滚轮）被剥', () => {
    expect(stripUntrustedAnsi('\x1b[?1000h\x1b[?1006h内容')).toBe('内容')
  })
  it('OSC 0 改标题钓鱼被剥（BEL 与 ST 两种终结）', () => {
    expect(stripUntrustedAnsi('a\x1b]0;⚠ 1 项审批待确认\x07b')).toBe('ab')
    expect(stripUntrustedAnsi('a\x1b]0;标题\x1b\\b')).toBe('ab')
  })
  it('OSC 52 剪贴板覆写被剥', () => {
    expect(stripUntrustedAnsi('\x1b]52;c;aGVsbG8=\x07粘贴安全')).toBe('粘贴安全')
  })
  it('OSC 8 链接欺骗被剥（显示文本保留、URI 通道消失）', () => {
    expect(stripUntrustedAnsi('\x1b]8;;https://evil\x07点我\x1b]8;;\x07')).toBe('点我')
  })
  it('DCS/PM/APC/SOS 与 ESC 单字符序列（RIS 全终端重置）被剥', () => {
    expect(stripUntrustedAnsi('a\x1bP0;1|data\x1b\\b')).toBe('ab')
    expect(stripUntrustedAnsi('a\x1bc b')).toBe('a b') // RIS
    expect(stripUntrustedAnsi('a\x1b7b\x1b8c')).toBe('abc') // 保存/恢复光标
  })
  it('C1 控制字节与裸 C0 被剥（BEL 骚扰/FF 扰屏；\\n 保留 \\t 展开空格）', () => {
    expect(stripUntrustedAnsi('a\u009bb\x07c\vd')).toBe('abcd')
    expect(stripUntrustedAnsi('行一\n行二\t缩进')).toBe('行一\n行二    缩进')
  })
  it('尾部孤立 ESC（未终结序列）整段丢弃', () => {
    expect(stripUntrustedAnsi('安全\x1b')).toBe('安全')
    expect(stripUntrustedAnsi('安全\x1b[3')).toBe('安全') // 劈半 CSI
  })
  it('正常文本与换行原样保留（白名单）', () => {
    const text = '结论：一切正常\n- 项一\n  ⚙ bash 完成'
    expect(stripUntrustedAnsi(text)).toBe(text)
  })
  it('SGR 颜色一期全剥（黑白阅读基调）', () => {
    expect(stripUntrustedAnsi('\x1b[31m红\x1b[0m文本')).toBe('红文本')
  })
})
