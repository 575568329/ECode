import { describe, it, expect } from 'vitest'
import {
  renderSkillListing,
  listingBudget,
  listingSignature,
  skillDesc,
  MAX_LISTING_DESC_CHARS,
  type SkillInfo,
} from '../../../src/services/skill/listing.js'

function skill(name: string, description: string, whenToUse?: string): SkillInfo {
  return {
    name,
    description,
    whenToUse,
    body: '',
    baseDir: `/tmp/${name}`,
    source: 'user',
    userInvocable: true,
    disableModelInvocation: false,
  }
}

describe('listingBudget', () => {
  it('1% 窗口，下限 2000', () => {
    expect(listingBudget(200_000)).toBe(2000)
    expect(listingBudget(1_000_000)).toBe(10000)
    expect(listingBudget(32_000)).toBe(2000)
  })
})

describe('skillDesc', () => {
  it('whenToUse 拼接 + 250 硬截断', () => {
    expect(skillDesc(skill('a', 'desc'))).toBe('desc')
    expect(skillDesc(skill('a', 'desc', '时机'))).toBe('desc（用于：时机）')
    const long = 'x'.repeat(400)
    expect(skillDesc(skill('a', long))).toHaveLength(MAX_LISTING_DESC_CHARS)
    expect(skillDesc(skill('a', long)).endsWith('…')).toBe(true)
  })
})

describe('renderSkillListing', () => {
  it('无 skill → 空串（零开销）', () => {
    expect(renderSkillListing([], 2000)).toBe('')
  })

  it('正常渲染：XML 块 + name/description', () => {
    const out = renderSkillListing([skill('commit', '按约定提交'), skill('review', '审查 diff')], 2000)
    expect(out).toContain('<available_skills>')
    expect(out).toContain('<name>commit</name><description>按约定提交</description>')
    expect(out).toContain('<name>review</name>')
    expect(out.endsWith('</available_skills>')).toBe(true)
  })

  it('超预算 → 均匀砍每条', () => {
    const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`, 'd'.repeat(200)))
    const out = renderSkillListing(skills, 1500)
    expect(out).toContain('<available_skills>')
    // 每条被砍到 ~预算均分，总 desc 长度受控
    const totalDesc = [...out.matchAll(/<description>([^<]*)<\/description>/g)].reduce((n, m) => n + m[1].length, 0)
    expect(totalDesc).toBeLessThan(1500)
  })

  it('极端小预算 → names-only 降级', () => {
    const skills = Array.from({ length: 50 }, (_, i) => skill(`skill-name-${i}`, 'd'.repeat(100)))
    const out = renderSkillListing(skills, 300)
    expect(out).toContain('仅列名')
    expect(out).not.toContain('<description>')
    expect(out).toContain('<name>skill-name-0</name>')
  })
})

describe('listingSignature', () => {
  it('内容不变 → 签名不变；变 → 签名变', () => {
    const a = [skill('x', 'd1'), skill('y', 'd2')]
    const b = [skill('x', 'd1'), skill('y', 'd2')]
    const c = [skill('x', 'd1'), skill('y', 'd3')]
    const d = [skill('x', 'd1')]
    expect(listingSignature(a)).toBe(listingSignature(b))
    expect(listingSignature(a)).not.toBe(listingSignature(c))
    expect(listingSignature(a)).not.toBe(listingSignature(d))
  })
})
