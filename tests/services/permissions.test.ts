/** 权限规则引擎测（M9-P5）：匹配/求值/三层加载与写入（tmpdir 真文件）。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ruleMatches,
  evalPermission,
  loadPermissionLayers,
  saveLocalPermission,
  type PermissionLayers,
} from '../../src/services/permissions.js'

describe('ruleMatches', () => {
  it('精确命中 / 尾 * 通配 / 不通配不命中', () => {
    expect(ruleMatches('Hook(skill:foo)', 'Hook(skill:foo)')).toBe(true)
    expect(ruleMatches('Hook(skill:*)', 'Hook(skill:foo)')).toBe(true)
    expect(ruleMatches('Hook(skill:foo)', 'Hook(skill:bar)')).toBe(false)
  })

  it('资源类型不同不互匹配（Hook ≠ Skill）', () => {
    expect(ruleMatches('Hook(*)', 'Skill(foo)')).toBe(false)
  })

  it('* 前缀不吞资源类型分隔（Hook(a:*) 不匹配 Hook(a:b:c) 应匹配——* 是纯前缀通配）', () => {
    expect(ruleMatches('Hook(a:*)', 'Hook(a:b:c)')).toBe(true)
    expect(ruleMatches('Hook(a:*)', 'Hook(a)')).toBe(false)
  })
})

describe('evalPermission（求值）', () => {
  const layers = (over: Partial<PermissionLayers>): PermissionLayers => over

  it('无任何规则 → 默认 ask（首次询问）', () => {
    expect(evalPermission('Hook(skill:foo)', layers({}))).toBe('ask')
  })

  it('deny 任意层终局（低层 allow 盖不住）', () => {
    expect(
      evalPermission('Hook(skill:foo)', layers({ local: { allow: ['Hook(skill:*)'], ask: [], deny: [] }, user: { allow: [], ask: [], deny: ['Hook(skill:foo)'] } })),
    ).toBe('deny')
  })

  it('层序 local > project > user（高层 ask 覆盖低层 allow）', () => {
    expect(
      evalPermission('Hook(skill:foo)', layers({
        project: { allow: ['Hook(skill:*)'], ask: [], deny: [] },
        user: { allow: ['Hook(skill:foo)'], ask: [], deny: [] },
      })),
    ).toBe('allow')
    expect(
      evalPermission('Hook(skill:foo)', layers({
        local: { allow: [], ask: ['Hook(skill:*)'], deny: [] },
        project: { allow: ['Hook(skill:*)'], ask: [], deny: [] },
      })),
    ).toBe('ask')
  })
})

describe('三层存储（真实文件）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecode-perm-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadPermissionLayers：三层独立读取；缺文件层为 undefined', () => {
    mkdirSync(join(dir, '.ecode'), { recursive: true })
    writeFileSync(join(dir, '.ecode', 'settings.json'), JSON.stringify({ permissions: { deny: ['Hook(bad:*)'] } }))
    const layers = loadPermissionLayers(dir)
    expect(layers.project).toEqual({ allow: [], ask: [], deny: ['Hook(bad:*)'] })
    expect(layers.local).toBeUndefined()
    expect(evalPermission('Hook(bad:x)', layers)).toBe('deny')
  })

  it('saveLocalPermission：写入 local 并保留其他键；去重', () => {
    saveLocalPermission(dir, 'allow', 'Hook(skill:foo)')
    saveLocalPermission(dir, 'allow', 'Hook(skill:foo)') // 去重
    saveLocalPermission(dir, 'deny', 'Hook(bad:*)')
    const doc = JSON.parse(readFileSync(join(dir, '.ecode', 'settings.local.json'), 'utf8'))
    expect(doc.permissions.allow).toEqual(['Hook(skill:foo)'])
    expect(doc.permissions.deny).toEqual(['Hook(bad:*)'])
    // 再写一条 allow 保留既有
    saveLocalPermission(dir, 'allow', 'Hook(plugin:p1)')
    const doc2 = JSON.parse(readFileSync(join(dir, '.ecode', 'settings.local.json'), 'utf8'))
    expect(doc2.permissions.allow).toEqual(['Hook(skill:foo)', 'Hook(plugin:p1)'])
  })
})
