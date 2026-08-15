import { describe, expect, it, beforeEach } from 'vitest'
import { askUserTool, validateAskUserInput, renderAnswers, type AskUserQuestion } from '../../../src/tools/builtin/ask_user.js'
import { setAskUserHandler } from '../../../src/tools/builtin/askUserBridge.js'

const qs: AskUserQuestion[] = [
  { question: '登录方式用哪种？', header: '登录方式', options: [{ label: '账号密码' }, { label: '手机验证码' }] },
]

beforeEach(() => {
  setAskUserHandler(null)
})

describe('validateAskUserInput（跨项唯一性）', () => {
  it('合法输入通过', () => {
    expect(validateAskUserInput(qs)).toBeNull()
  })
  it('问题文本重复 / label 重复 / header 超长 → 拒绝', () => {
    expect(
      validateAskUserInput([
        { question: 'A？', header: 'h1', options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'A？', header: 'h2', options: [{ label: 'x' }, { label: 'y' }] },
      ]),
    ).toContain('问题文本重复')
    expect(
      validateAskUserInput([{ question: 'A？', header: 'h', options: [{ label: 'x' }, { label: 'x' }] }]),
    ).toContain('选项重复')
    expect(
      validateAskUserInput([{ question: 'A？', header: '这是一个超过十二个字的标签', options: [{ label: 'x' }, { label: 'y' }] }]),
    ).toContain('12 字符')
  })
})

describe('askUserTool.execute', () => {
  it('非法输入（重复选项）→ is_error 可自纠', async () => {
    const r = await askUserTool.execute(
      { questions: [{ question: 'A？', header: 'h', options: [{ label: 'x' }, { label: 'x' }] }] },
      { cwd: '.', signal: new AbortController().signal },
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('选项重复')
  })

  it('非交互（无 handler）→ 返回提示不挂死、非 is_error', async () => {
    const r = await askUserTool.execute({ questions: qs }, { cwd: '.', signal: new AbortController().signal })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain('非交互环境')
  })

  it('UI 答案 → 回传格式 User has answered', async () => {
    setAskUserHandler(async () => ({ kind: 'answers', answers: ['账号密码'] }))
    const r = await askUserTool.execute({ questions: qs }, { cwd: '.', signal: new AbortController().signal })
    expect(r.content).toBe('User has answered your questions: "登录方式用哪种？"="账号密码". You can now continue with the user\'s answers in mind.')
  })

  it('用户取消 → 明确信号', async () => {
    setAskUserHandler(async () => ({ kind: 'cancel' }))
    const r = await askUserTool.execute({ questions: qs }, { cwd: '.', signal: new AbortController().signal })
    expect(r.content).toContain('用户取消了提问')
  })

  it('多选答案逗号连接', async () => {
    const multi: AskUserQuestion[] = [{ question: '选哪些？', header: '框架', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true }]
    expect(renderAnswers(multi, [['a', 'c']])).toContain('"选哪些？"="a, c"')
  })
})

describe('排队锁（同轮多个 ask_user 串行）', () => {
  it('先到先弹，后到排队（handler 串行收到）', async () => {
    const received: number[] = []
    let releaseFirst: (() => void) | null = null
    let call = 0
    setAskUserHandler(async () => {
      call += 1
      received.push(call)
      if (call === 1) {
        // 第一个挂住，验证第二个不被并发调度
        await new Promise<void>((r) => { releaseFirst = r })
      }
      return { kind: 'cancel' }
    })
    const p1 = askUserTool.execute({ questions: qs }, { cwd: '.', signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 20))
    const p2 = askUserTool.execute({ questions: qs }, { cwd: '.', signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toEqual([1]) // 第二个还在排队
    releaseFirst?.()
    await Promise.all([p1, p2])
    expect(received).toEqual([1, 2])
  })
})
