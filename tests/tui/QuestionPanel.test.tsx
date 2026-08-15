import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { QuestionPanel } from '../../src/tui/QuestionPanel.js'
import type { AskUserQuestion, AskUserResult } from '../../src/tools/builtin/ask_user.js'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const single: AskUserQuestion[] = [
  { question: '登录方式用哪种？', header: '登录方式', options: [{ label: '账号密码 (Recommended)' }, { label: '手机验证码' }] },
]

function renderPanel(qs: AskUserQuestion[], onResolve = vi.fn()) {
  const onCancel = vi.fn()
  const el = render(
    React.createElement(QuestionPanel, {
      questions: qs,
      resolve: onResolve as (r: AskUserResult) => void,
      onCancel,
    }),
  )
  return { ...el, onResolve, onCancel }
}

describe('QuestionPanel 单问单选', () => {
  it('渲染问句/选项/Other/键位', () => {
    const { lastFrame } = renderPanel(single)
    const f = lastFrame() ?? ''
    expect(f).toContain('登录方式用哪种？')
    expect(f).toContain('1. 账号密码 (Recommended)')
    expect(f).toContain('Other')
    expect(f).toContain('Esc 取消提问')
  })

  it('↓ 选中第二项 + 回车 → 直接 resolve 答案（无 Review）', async () => {
    const { onResolve, stdin } = renderPanel(single)
    await flush()
    stdin.write('\u001b[B')
    await flush()
    stdin.write('\r')
    await flush()
    expect(onResolve).toHaveBeenCalledWith({ kind: 'answers', answers: ['手机验证码'] })
  })

  it('Esc → onCancel（取消提问）', async () => {
    const { onCancel, stdin } = renderPanel(single)
    await flush()
    stdin.write('\u001b')
    await flush()
    expect(onCancel).toHaveBeenCalled()
  })

  it('Other 回车 → 内联输入 → 回车提交自定义答案', async () => {
    const { onResolve, stdin, lastFrame } = renderPanel(single)
    await flush()
    stdin.write('\u001b[B'); await flush()
    stdin.write('\u001b[B'); await flush() // ↓↓ 到 Other
    stdin.write('\r'); await flush()
    expect(lastFrame() ?? '').toContain('Other：')
    stdin.write('微信扫码'); await flush()
    stdin.write('\r'); await flush()
    expect(onResolve).toHaveBeenCalledWith({ kind: 'answers', answers: ['微信扫码'] })
  })

  it('Other 空输入回车 → 退回选择不提交', async () => {
    const { onResolve, stdin, lastFrame } = renderPanel(single)
    await flush()
    stdin.write('\u001b[B'); await flush()
    stdin.write('\u001b[B'); await flush()
    stdin.write('\r'); await flush()
    stdin.write('\r'); await flush() // 空输入回车
    expect(onResolve).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').not.toContain('Other：')
  })
})

describe('QuestionPanel 多问 + 多选 + Review', () => {
  const multi: AskUserQuestion[] = [
    { question: '选哪些框架？', header: '框架', options: [{ label: 'react' }, { label: 'vue' }, { label: 'svelte' }], multiSelect: true },
    { question: '用哪种样式方案？', header: '样式', options: [{ label: 'tailwind' }, { label: 'css modules' }] },
  ]

  it('chips 进度显示（○ 未答 / ● 已答）', async () => {
    const { stdin, lastFrame } = renderPanel(multi)
    await flush()
    expect(lastFrame() ?? '').toContain('○框架')
    // space 勾选第一项 → 回车进下一题
    stdin.write(' '); await flush()
    stdin.write('\r'); await flush()
    const f = lastFrame() ?? ''
    expect(f).toContain('●框架')
    expect(f).toContain('样式')
  })

  it('多选 space toggle 两项 → 回车 → 下一题 → 回车 → Review → 回车提交全部', async () => {
    const { onResolve, stdin, lastFrame } = renderPanel(multi)
    await flush()
    stdin.write(' '); await flush()          // toggle react
    stdin.write('\u001b[B'); await flush()  // ↓ vue
    stdin.write(' '); await flush()          // toggle vue
    stdin.write('\r'); await flush()         // 确认本题 → 题 2
    expect(lastFrame() ?? '').toContain('tailwind')
    stdin.write('\r'); await flush()         // 题 2 选第一项 → Review
    const rv = lastFrame() ?? ''
    expect(rv).toContain('确认答案')
    expect(rv).toContain('react、vue')
    expect(rv).toContain('tailwind')
    stdin.write('\r'); await flush()         // Review 提交
    expect(onResolve).toHaveBeenCalledWith({ kind: 'answers', answers: [['react', 'vue'], 'tailwind'] })
  })

  it('Review ← 返回修改（回到最后一题）', async () => {
    const { onResolve, stdin, lastFrame } = renderPanel(multi)
    await flush()
    stdin.write('\r'); await flush()  // 题1（多选空选回车=空数组进下一题）
    stdin.write('\r'); await flush()  // 题2 → Review
    expect(lastFrame() ?? '').toContain('确认答案')
    stdin.write('\u001b[D'); await flush() // ← 返回
    expect(lastFrame() ?? '').toContain('tailwind')
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('→ 跳过未答 → Review 以（未作答）占位提交不挂死', async () => {
    const { onResolve, stdin } = renderPanel(multi)
    await flush()
    stdin.write('\u001b[C'); await flush() // → 跳过题1
    stdin.write('\u001b[C'); await flush() // → 跳过题2 到 Review
    stdin.write('\r'); await flush()
    expect(onResolve).toHaveBeenCalledWith({
      kind: 'answers',
      answers: ['（未作答）', '（未作答）'],
    })
  })

  it('Review 页 Esc 取消', async () => {
    const { onCancel, stdin } = renderPanel(multi)
    await flush()
    stdin.write('\u001b[C'); await flush()
    stdin.write('\u001b[C'); await flush()
    stdin.write('\u001b'); await flush()
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('审阅修复：多选 + Other 组合不丢勾选（P1-5）', () => {
  it('space 勾选两项后经 Other 输入 → 答案含勾选项与自定义文本', async () => {
    const multi: AskUserQuestion[] = [
      { question: '选哪些？', header: '框架', options: [{ label: 'react' }, { label: 'vue' }], multiSelect: true },
    ]
    const { onResolve, stdin } = renderPanel(multi)
    await flush()
    stdin.write(' '); await flush()          // toggle react
    stdin.write('\u001b[B'); await flush()  // ↓ vue
    stdin.write(' '); await flush()          // toggle vue
    stdin.write('\u001b[B'); await flush()  // ↓ Other（两选项+Other，下标 2）
    stdin.write('\r'); await flush()         // 进 Other 输入
    stdin.write('svelte'); await flush()
    stdin.write('\r'); await flush()         // 提交（单问多选 → Review）
    stdin.write('\r'); await flush()         // Review 确认
    expect(onResolve).toHaveBeenCalledWith({ kind: 'answers', answers: [['react', 'vue', 'svelte']] })
  })
})
