/**
 * web 客户端状态机（zustand 单 store）：mux 帧驱动视图演进 + host 帧列表同步 + 历史投影。
 * store 只依赖类型层（connect 的 import type 编译期擦除）——node 环境直测，无 DOM/网络。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyView, toConfigView, useApp } from '../src/store'

const initial = useApp.getState()
beforeEach(() => {
  useApp.setState(initial, true)
})

const frame = (sessionId: string, ev: Record<string, unknown>): void => {
  useApp.getState().applyFrame({ project: 'D:/proj', sessionId, ev })
}

describe('流式轮演进', () => {
  it('delta 累积 → turn/completed 并入 entries 清空 streaming', () => {
    frame('s1', { type: 'delta', text: '你' })
    frame('s1', { type: 'delta', text: '好' })
    let v = useApp.getState().views.s1
    expect(v?.streaming).toBe('你好')
    expect(v?.entries).toEqual([])
    frame('s1', { type: 'turn/completed' })
    v = useApp.getState().views.s1
    expect(v?.entries).toEqual([{ kind: 'assistant', text: '你好' }])
    expect(v?.streaming).toBe('')
  })
  it('turn/completed 空流不落空条目', () => {
    frame('s1', { type: 'turn/completed' })
    expect(useApp.getState().views.s1?.entries).toEqual([])
  })
  it('tool 卡：started→running，completed→终态带摘要', () => {
    frame('s1', { type: 'item/started', itemId: 'i1', name: 'bash' })
    frame('s1', { type: 'item/completed', itemId: 'i1', summary: 'ls 完成', content: 'a.txt' })
    expect(useApp.getState().views.s1?.items).toEqual([{ id: 'i1', name: 'bash', status: 'done', summary: 'ls 完成', content: 'a.txt' }])
  })
  it('queue/snapshot 更新队列；session/clear 全清', () => {
    frame('s1', { type: 'queue/snapshot', items: ['q1', 'q2'] })
    expect(useApp.getState().views.s1?.queue).toEqual(['q1', 'q2'])
    frame('s1', { type: 'session/clear' })
    expect(useApp.getState().views.s1).toEqual(emptyView())
  })
  it('thread/status 翻新会话列表 running', () => {
    useApp.getState().upsertSession({ project: 'D:/proj', sessionId: 's1', running: false, title: 't', updatedAt: 1 })
    frame('s1', { type: 'thread/status', busy: true })
    expect(useApp.getState().sessions[0]?.running).toBe(true)
    frame('s1', { type: 'thread/status', busy: false })
    expect(useApp.getState().sessions[0]?.running).toBe(false)
  })
})

describe('审批/单选 takeover', () => {
  it('requested 挂起 → resolved 同 requestId 卸载', () => {
    frame('s1', { type: 'approval/requested', requestId: 'r1', tool: 'bash', preview: 'rm -rf', decisions: ['once', 'always', 'reject'] })
    expect(useApp.getState().views.s1?.approval?.tool).toBe('bash')
    frame('s1', { type: 'approval/resolved', requestId: 'r1' })
    expect(useApp.getState().views.s1?.approval).toBeNull()
  })
  it('resolved 异 requestId 不误卸载', () => {
    frame('s1', { type: 'approval/requested', requestId: 'r1', tool: 'bash', preview: '', decisions: ['once', 'reject'] })
    frame('s1', { type: 'approval/resolved', requestId: '别的' })
    expect(useApp.getState().views.s1?.approval).not.toBeNull()
  })
  it('askSelect 同构', () => {
    frame('s1', { type: 'askSelect/requested', requestId: 'q1', title: '选一个', options: ['a', 'b'] })
    expect(useApp.getState().views.s1?.askSelect?.options).toEqual(['a', 'b'])
    frame('s1', { type: 'askSelect/resolved', requestId: 'q1' })
    expect(useApp.getState().views.s1?.askSelect).toBeNull()
  })
})

describe('host 帧列表同步', () => {
  it('session/baseline 合并不替换（重订只含订阅会话——替换会洗掉其他会话，G3 实测）', () => {
    useApp.getState().upsertSession({ project: 'D:/proj', sessionId: 's-other', running: false, title: '旧', updatedAt: 1 })
    useApp.getState().applyHost({ type: 'session/baseline', projects: ['D:/proj'], sessions: [{ project: 'D:/proj', sessionId: 's1', running: true, title: '新', updatedAt: 2 }] })
    const ids = useApp.getState().sessions.map((s) => s.sessionId)
    expect(ids).toContain('s-other')
    expect(ids).toContain('s1')
  })
  it('session/created 幂等（不重复入列）', () => {
    const brief = { project: 'D:/proj', sessionId: 's1', running: false, title: '', updatedAt: 1 }
    useApp.getState().applyHost({ type: 'session/created', brief })
    useApp.getState().applyHost({ type: 'session/created', brief })
    expect(useApp.getState().sessions.filter((s) => s.sessionId === 's1')).toHaveLength(1)
  })
  it('project/added 并集去重；project/removed 级联清会话', () => {
    useApp.getState().setProjects(['D:/a'])
    useApp.getState().applyHost({ type: 'project/added', project: 'D:/a' })
    useApp.getState().applyHost({ type: 'project/added', project: 'D:/b' })
    expect(useApp.getState().projects).toEqual(['D:/a', 'D:/b'])
    useApp.getState().upsertSession({ project: 'D:/b', sessionId: 's9', running: false, title: '', updatedAt: 1 })
    useApp.getState().applyHost({ type: 'project/removed', project: 'D:/b' })
    expect(useApp.getState().projects).toEqual(['D:/a'])
    expect(useApp.getState().sessions.some((s) => s.project === 'D:/b')).toBe(false)
  })
})

describe('loadHistory 历史投影', () => {
  it('tool_use/tool_result 配对：成败/摘要/附着图落到 tool 条目', () => {
    const lines = [
      { role: 'user', content: [{ type: 'text', text: '看下这个图' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来看' },
          { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '第一行摘要\n详情', is_error: false, blocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }] },
    ]
    useApp.getState().loadHistory('s1', lines)
    const v = useApp.getState().views.s1
    expect(v?.loaded).toBe(true)
    expect(v?.entries).toEqual([
      { kind: 'user', text: '看下这个图' },
      { kind: 'assistant', text: '我来看' },
      { kind: 'tool', text: '第一行摘要', name: 'read_file', ok: true, images: [{ mediaType: 'image/png', data: 'aGk=' }] },
      { kind: 'tool', text: 'boom', name: 'bash', ok: false },
    ])
  })
  it('user 纯图消息（无文本）保留', () => {
    useApp.getState().loadHistory('s1', [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AA==' } }] }])
    expect(useApp.getState().views.s1?.entries).toEqual([{ kind: 'user', text: '', images: [{ mediaType: 'image/jpeg', data: 'AA==' }] }])
  })
  it('非数组负载只置 loaded（不炸）', () => {
    useApp.getState().loadHistory('s1', undefined)
    expect(useApp.getState().views.s1?.loaded).toBe(true)
    expect(useApp.getState().views.s1?.entries).toEqual([])
  })
  it('审阅批：补拉落定时流式缓冲并入 entries 尾部（不再丢字）', () => {
    frame('s1', { type: 'delta', text: '迟到的增量' }) // read 快照晚于 delta 到达的竞态窗口
    useApp.getState().loadHistory('s1', [{ role: 'user', content: [{ type: 'text', text: '问' }] }])
    const v = useApp.getState().views.s1
    expect(v?.entries).toEqual([
      { kind: 'user', text: '问' },
      { kind: 'assistant', text: '迟到的增量' },
    ])
    expect(v?.streaming).toBe('')
  })
})

describe('config/changed 投影（W9 顶栏）', () => {
  it('redact 后 config → 窄视图；非典型负载保持旧值', () => {
    const cfg = { current: { name: 'p1', model: 'glm-x' }, providers: { p1: { models: ['glm-x', 'glm-y'], apiKey: '***' }, p2: { models: '坏的' } } }
    useApp.getState().applyFrame({ project: 'D:/proj', sessionId: 's1', ev: { type: 'config/changed', config: cfg } })
    expect(useApp.getState().configView).toEqual({ currentName: 'p1', currentModel: 'glm-x', modelsByProvider: { p1: ['glm-x', 'glm-y'] } })
    // 坏负载：视图保持
    useApp.getState().applyFrame({ project: 'D:/proj', sessionId: 's1', ev: { type: 'config/changed', config: null } })
    expect(useApp.getState().configView.currentModel).toBe('glm-x')
  })
  it('toConfigView 直接解析（含 models 非字符串元素过滤）', () => {
    expect(toConfigView({ current: { name: 'a', model: 'm' }, providers: { a: { models: ['m', 3, null] } } })).toEqual({
      currentName: 'a',
      currentModel: 'm',
      modelsByProvider: { a: ['m'] },
    })
    expect(toConfigView('x')).toBeNull()
  })
})

describe('appendUser（发送成功即时上屏——user 消息不经帧回推）', () => {
  it('追加不改其他视图态', () => {
    useApp.getState().loadHistory('s1', [])
    useApp.getState().appendUser('s1', '在吗')
    const v = useApp.getState().views.s1
    expect(v?.entries).toEqual([{ kind: 'user', text: '在吗' }])
    expect(v?.streaming).toBe('')
  })
})

describe('M14-C4②：error/systemMsg/notice 帧入对话流', () => {
  it('error 帧 → system 行 error 标记（红显）；systemMsg → 灰显 system 行', () => {
    frame('s1', { type: 'error', message: '模型请求失败' })
    frame('s1', { type: 'systemMsg', text: 'read-only 模式：MCP 工具被拒绝' })
    const entries = useApp.getState().views.s1?.entries
    expect(entries).toEqual([
      { kind: 'system', text: '模型请求失败', error: true },
      { kind: 'system', text: 'read-only 模式：MCP 工具被拒绝' },
    ])
  })
  it('notice 三级：error 红 / warn·info 灰带前缀', () => {
    frame('s1', { type: 'notice', level: 'warn', text: 'lint 有失败' })
    frame('s1', { type: 'notice', level: 'error', text: '炸了' })
    const entries = useApp.getState().views.s1?.entries
    expect(entries?.[0]).toEqual({ kind: 'system', text: '⚠ lint 有失败' })
    expect(entries?.[1]).toEqual({ kind: 'system', text: '✖ 炸了', error: true })
  })
})

describe('M14-C4③：askUser 自由文本问答 takeover', () => {
  it('requested 投影 questions（字段收窄）→ resolved 同 requestId 卸载', () => {
    frame('s1', {
      type: 'askUser/requested',
      requestId: 'au1',
      questions: [
        { question: '用哪个数据库？', header: 'DB', options: [{ label: 'postgres' }, { label: 'mysql', description: '老项目' }], multiSelect: false },
        { question: '选哪些特性？', header: 'FEAT', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
      ],
    })
    const v = useApp.getState().views.s1
    expect(v?.askUser?.requestId).toBe('au1')
    expect(v?.askUser?.questions[0]).toEqual({ question: '用哪个数据库？', header: 'DB', options: [{ label: 'postgres' }, { label: 'mysql', description: '老项目' }] })
    expect(v?.askUser?.questions[1]?.multiSelect).toBe(true)
    frame('s1', { type: 'askUser/resolved', requestId: 'au1' })
    expect(useApp.getState().views.s1?.askUser).toBeNull()
  })
  it('resolved 异 requestId 不误卸载；非数组 questions 容错为空表单', () => {
    frame('s1', { type: 'askUser/requested', requestId: 'au1', questions: 'not-array' })
    expect(useApp.getState().views.s1?.askUser?.questions).toEqual([])
    frame('s1', { type: 'askUser/requested', requestId: 'au2', questions: [{ question: 'q' }] })
    frame('s1', { type: 'askUser/resolved', requestId: 'other' })
    expect(useApp.getState().views.s1?.askUser?.requestId).toBe('au2')
  })
})

describe('M14-C2⑤ 补账：approval/claimed 他端认领标记', () => {
  it('claimed 帧给挂起审批加 claimedBy；resolved 卸载不受影响', () => {
    frame('s1', { type: 'approval/requested', requestId: 'r1', tool: 'bash', preview: 'rm', decisions: ['once', 'reject'] })
    frame('s1', { type: 'approval/claimed', requestId: 'r1', claimant: 'web-手机' })
    expect(useApp.getState().views.s1?.approval?.claimedBy).toBe('web-手机')
    frame('s1', { type: 'approval/resolved', requestId: 'r1' })
    expect(useApp.getState().views.s1?.approval).toBeNull()
  })
})
