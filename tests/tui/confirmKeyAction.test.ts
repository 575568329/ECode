/**
 * 审阅 P0-B：confirmKeyAction 纯函数直测（「纯函数便于单测」的兑现——此前 tests/ 全目录
 * 零命中，批2b④/①/②/⑤的按键语义全靠 ink-testing 组件级间接覆盖，回归面有洞）。
 * 键形态对齐 ink useInput 的 parse-keypress 产物（return/backspace/delete/escape/ctrl/meta/tab）。
 */
import { describe, it, expect } from 'vitest'
import { confirmKeyAction, type ConfirmKeyCtx } from '../../src/tui/ConfirmPrompt.js'
import { createCursor } from '../../src/tui/cursor.js'

const baseCtx = (patch: Partial<ConfirmKeyCtx> = {}): ConfirmKeyCtx => ({
  hasDraft: false,
  selected: null,
  reasonMode: false,
  reason: createCursor(''),
  canAlways: false,
  canExpand: false,
  expanded: false,
  ...patch,
})

describe('confirmKeyAction：方向键循环回绕', () => {
  it('三键卡（canAlways）：null 起点按 ← 落到 n（order 末位回绕到前一位 y→a→n 语义的最左）', () => {
    // order=['y','n','a']；selected=null 时 cur=order.length-1=2（a 位），← → (2-1)=1='n'
    const r = confirmKeyAction('', { leftArrow: true }, baseCtx({ canAlways: true }))
    expect(r).toEqual({ action: 'select', choice: 'n' })
  })

  it('三键卡：null 起点按 → 落到 y（a 位右移回绕）', () => {
    const r = confirmKeyAction('', { rightArrow: true }, baseCtx({ canAlways: true }))
    expect(r).toEqual({ action: 'select', choice: 'y' })
  })

  it('双键卡（无 a）：null 起点按 ← 落到 y（order=[y,n] cur=1，←→0）', () => {
    const r = confirmKeyAction('', { leftArrow: true }, baseCtx())
    expect(r).toEqual({ action: 'select', choice: 'y' })
  })

  it('双键卡：null 起点按 → 也落到 y（cur=n 位，+1 回绕到 0）', () => {
    const r = confirmKeyAction('', { rightArrow: true }, baseCtx())
    expect(r).toEqual({ action: 'select', choice: 'y' })
  })

  it('已选 y 按 ← 回绕到 n（双键卡：y=0 → −1 → 回绕 1）', () => {
    const r = confirmKeyAction('', { leftArrow: true }, baseCtx({ selected: 'y' }))
    expect(r).toEqual({ action: 'select', choice: 'n' })
  })

  it('三键卡已选 y 按 → 到 n；已选 a 按 → 回绕 y', () => {
    expect(confirmKeyAction('', { rightArrow: true }, baseCtx({ selected: 'y', canAlways: true }))).toEqual({
      action: 'select',
      choice: 'n',
    })
    expect(confirmKeyAction('', { rightArrow: true }, baseCtx({ selected: 'a', canAlways: true }))).toEqual({
      action: 'select',
      choice: 'y',
    })
  })
})

describe('confirmKeyAction：单字母快捷与草稿让位（批2b①②）', () => {
  it('空草稿 y/n/a：显式选择并立即确认；a 需 canAlways', () => {
    expect(confirmKeyAction('y', {}, baseCtx())).toEqual({ action: 'confirm', ok: true })
    expect(confirmKeyAction('n', {}, baseCtx())).toEqual({ action: 'confirm', ok: false })
    expect(confirmKeyAction('a', {}, baseCtx())).toEqual({ action: 'draft' }) // canAlways=false：a 不是快捷
    expect(confirmKeyAction('a', {}, baseCtx({ canAlways: true }))).toEqual({ action: 'confirm', ok: true, always: true })
  })

  it('canAlways=false 时 a 落 draft（进输入框，不误批）', () => {
    const r = confirmKeyAction('a', {}, baseCtx({ canAlways: false }))
    expect(r).toEqual({ action: 'draft' })
  })

  it('草稿非空时 y/n/a 全让位进草稿（打 yes 首字母不误触发）', () => {
    for (const c of ['y', 'n', 'a'] as const) {
      expect(confirmKeyAction(c, {}, baseCtx({ hasDraft: true, canAlways: true }))).toEqual({ action: 'draft' })
    }
  })

  it('草稿非空时 v 让位进草稿（v 是常见单词字母）', () => {
    expect(confirmKeyAction('v', {}, baseCtx({ hasDraft: true, canExpand: true }))).toEqual({ action: 'draft' })
  })

  it('空草稿 v（canExpand）= toggle-expand；不可展开时落 draft', () => {
    expect(confirmKeyAction('v', {}, baseCtx({ canExpand: true }))).toEqual({ action: 'toggle-expand' })
    expect(confirmKeyAction('v', {}, baseCtx({ canExpand: false }))).toEqual({ action: 'draft' })
  })

  it('大写 Y 进草稿（非快捷——快捷只认小写）', () => {
    expect(confirmKeyAction('Y', {}, baseCtx())).toEqual({ action: 'draft' })
  })

  it('Ctrl/Meta 组合键不触发快捷（y 带 ctrl=none：既不确认也不进草稿）', () => {
    expect(confirmKeyAction('y', { ctrl: true }, baseCtx())).toEqual({ action: 'none' })
    expect(confirmKeyAction('n', { meta: true }, baseCtx())).toEqual({ action: 'none' })
    // ctrl+c 例外：F-31 拒卡+中断整轮（用户拍板「按一下直接退出 loop」——与 Esc 纯拒绝分家）
    expect(confirmKeyAction('c', { ctrl: true }, baseCtx())).toEqual({ action: 'confirm', ok: false, interrupt: true })
  })

  it('普通字符/退格/Delete/Home/End 进 draft（①不吞）；Tab 不进', () => {
    expect(confirmKeyAction('x', {}, baseCtx())).toEqual({ action: 'draft' })
    expect(confirmKeyAction('', { backspace: true }, baseCtx())).toEqual({ action: 'draft' })
    expect(confirmKeyAction('', { delete: true }, baseCtx())).toEqual({ action: 'draft' })
    expect(confirmKeyAction('', { home: true }, baseCtx())).toEqual({ action: 'draft' })
    expect(confirmKeyAction('', { end: true }, baseCtx())).toEqual({ action: 'draft' })
    expect(confirmKeyAction('', { tab: true }, baseCtx())).toEqual({ action: 'none' })
  })
})

describe('confirmKeyAction：Enter 直批+草稿防误批（F-32 翻案批2b④）', () => {
  it('默认选中 y（null 理论路径同 y 口径）+空草稿 Enter=批准', () => {
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ selected: 'y' }))).toEqual({ action: 'confirm', ok: true })
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ selected: null }))).toEqual({ action: 'confirm', ok: true })
  })

  it('草稿非空时 Enter 仍走草稿提交（插话），不误批——即便已选 y', () => {
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ hasDraft: true, selected: 'y' }))).toEqual({ action: 'draft' })
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ hasDraft: true, selected: null }))).toEqual({ action: 'draft' })
  })

  it('已选 n Enter=拒绝；已选 a Enter=always 确认', () => {
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ selected: 'n' }))).toEqual({ action: 'confirm', ok: false })
    expect(confirmKeyAction('\r', { return: true }, baseCtx({ selected: 'a' }))).toEqual({
      action: 'confirm',
      ok: true,
      always: true,
    })
  })

  it('Esc=拒绝（③直觉出口）', () => {
    expect(confirmKeyAction('', { escape: true }, baseCtx())).toEqual({ action: 'confirm', ok: false })
  })
})

describe('confirmKeyAction：理由模式（批2b⑤）', () => {
  const reasonCtx = (text = ''): ConfirmKeyCtx => baseCtx({ reasonMode: true, reason: createCursor(text) })

  it('Enter 提交拒绝（reason-enter）；Esc 返回不误拒（reason-cancel）', () => {
    expect(confirmKeyAction('\r', { return: true }, reasonCtx('理由'))).toEqual({ action: 'reason-enter' })
    expect(confirmKeyAction('', { escape: true }, reasonCtx('理由'))).toEqual({ action: 'reason-cancel' })
  })

  it('字符编辑进理由（reason-edit 追加）；Ctrl 组合在理由模式同样不进文本', () => {
    const r = confirmKeyAction('字', {}, reasonCtx('前'))
    expect(r.action).toBe('reason-edit')
    if (r.action === 'reason-edit') expect(r.next.text).toBe('前字')
    expect(confirmKeyAction('y', { ctrl: true }, reasonCtx()).action).toBe('none')
  })

  it('←→/退格在理由模式编辑理由（不触发选择/草稿）', () => {
    expect(confirmKeyAction('', { leftArrow: true }, reasonCtx('ab')).action).toBe('reason-edit')
    expect(confirmKeyAction('', { backspace: true }, reasonCtx('ab')).action).toBe('reason-edit')
  })

  it('r 进理由模式（reason-edit 原文起步——不直接拒绝）', () => {
    expect(confirmKeyAction('r', {}, baseCtx())).toEqual({ action: 'reason-edit', next: createCursor('') })
  })
})
