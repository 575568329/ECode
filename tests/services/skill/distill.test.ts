import { describe, it, expect } from 'vitest'
import {
  extractJson,
  parseCandidate,
  parseMergerVerdicts,
  conflictTitles,
  decisionsFromVerdicts,
  patchBodyFromVerdicts,
  renderCreatePreview,
  renderUpgradePreview,
  serializeSession,
} from '../../../src/services/skill/distill.js'
import type { Message } from '../../../src/core/types.js'

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

describe('extractJson', () => {
  it('围栏 JSON / 裸 JSON / 无 JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('前缀 {"a":{"b":2}} 后缀')).toEqual({ a: { b: 2 } })
    expect(extractJson('没有 json')).toBeNull()
    expect(extractJson('坏的 {"a":')).toBeNull()
  })
})

describe('parseCandidate', () => {
  it('合法起草输出 → SkillCandidate', () => {
    const raw = '```json\n{"name":"commit","description":"按约定提交","when_to_use":"用户要求提交时","body":"# commit\\n## 步骤\\n1. x"}\n```'
    const c = parseCandidate(raw)
    expect(c.name).toBe('commit')
    expect(c.whenToUse).toBe('用户要求提交时')
    expect(c.body).toContain('## 步骤')
  })

  it('error 字段 → 抛错（无可复用工作流）', () => {
    expect(() => parseCandidate('{"error":"无可复用工作流"}')).toThrow('无可复用工作流')
  })

  it('name 非法 / description 空 / body 空 → 抛错', () => {
    expect(() => parseCandidate('{"name":"Bad","description":"d","body":"b"}')).toThrow('name')
    expect(() => parseCandidate('{"name":"ok","description":"","body":"b"}')).toThrow('description')
    expect(() => parseCandidate('{"name":"ok","description":"d","body":""}')).toThrow('body')
    expect(() => parseCandidate('不是 json')).toThrow('JSON')
  })
})

describe('merger 协议', () => {
  const raw = '{"sections":[{"title":"步骤","verdict":"conflict","body":"## 步骤\\n新"},{"title":"备注","verdict":"add","body":"## 备注\\n新"},{"title":"简介","verdict":"equal"}]}'

  it('parseMergerVerdicts 三态', () => {
    const v = parseMergerVerdicts(raw)
    expect(v).toHaveLength(3)
    expect(v[0]).toMatchObject({ title: '步骤', verdict: 'conflict' })
    expect(v[2].body).toBeUndefined()
  })

  it('非法 verdict → 抛错', () => {
    expect(() => parseMergerVerdicts('{"sections":[{"title":"x","verdict":"wat"}]}')).toThrow('verdict')
    expect(() => parseMergerVerdicts('{"nope":1}')).toThrow('sections')
  })

  it('conflictTitles', () => {
    expect(conflictTitles(parseMergerVerdicts(raw))).toEqual(['步骤'])
  })

  it('decisionsFromVerdicts：equal→keep；conflict 按裁决（按 verdict 原序）', () => {
    const v = parseMergerVerdicts(raw)
    expect(decisionsFromVerdicts(v, 'adopt')).toEqual([
      { title: '步骤', verdict: 'adopt' },
      { title: '简介', verdict: 'keep' },
    ])
    expect(decisionsFromVerdicts(v, 'keep')).toEqual([
      { title: '步骤', verdict: 'keep' },
      { title: '简介', verdict: 'keep' },
    ])
  })

  it('patchBodyFromVerdicts：保留 add + adopt 的 conflict，丢 equal/keep', () => {
    const v = parseMergerVerdicts(raw)
    const body = '# 引言\n\n## 简介\n旧\n\n## 步骤\n旧\n'
    const patch = patchBodyFromVerdicts(body, v, 'adopt')
    expect(patch).toContain('## 步骤\n新')
    expect(patch).toContain('## 备注\n新')
    expect(patch).not.toContain('## 简介')
    const patchKeep = patchBodyFromVerdicts(body, v, 'keep')
    expect(patchKeep).not.toContain('## 步骤')
    expect(patchKeep).toContain('## 备注')
  })
})

describe('预览渲染', () => {
  it('创建预览含名字/描述/body', () => {
    const p = renderCreatePreview({ name: 'a', description: 'd', body: '## S\n内容' })
    expect(p).toContain('创建 skill「a」')
    expect(p).toContain('## S')
  })

  it('升级预览：三态行 + 裁决结果', () => {
    const v = parseMergerVerdicts('{"sections":[{"title":"新节","verdict":"add","body":"x"},{"title":"冲突节","verdict":"conflict","body":"y"}]}')
    const p = renderUpgradePreview({ name: 'a', description: 'd', body: '' }, v, 'keep')
    expect(p).toContain('+ 新节')
    expect(p).toContain('! 冲突节 → 保留现有')
    expect(p).toContain('versions/')
  })
})

describe('serializeSession', () => {
  it('按角色转写 + 截断上限', () => {
    const out = serializeSession([msg('user', '你好'), msg('assistant', '在的')])
    expect(out).toContain('[User]: 你好')
    expect(out).toContain('[Assistant]: 在的')
    const big = serializeSession([msg('user', 'x'.repeat(100_000))])
    expect(big.length).toBeLessThanOrEqual(60_000)
  })
})
