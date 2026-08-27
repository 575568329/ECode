/** 权限规则引擎测（M9-P5）：匹配/求值/三层加载与写入（tmpdir 真文件）。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ruleMatches,
  evalPermission,
  loadPermissionLayers,
  saveLocalPermission,
  setPermissionAsker,
  currentPermissionAsker,
  askPermissionInteractive,
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

  it('层序 local > project > user（高层命中覆盖低层）', () => {
    expect(
      evalPermission('Hook(skill:foo)', layers({
        local: { allow: [], ask: ['Hook(skill:*)'], deny: [] },
        project: { allow: [], ask: [], deny: [] },
        user: { allow: ['Hook(skill:foo)'], ask: [], deny: [] },
      })),
    ).toBe('ask')
    expect(
      evalPermission('Hook(skill:foo)', layers({
        local: { allow: ['Hook(skill:foo)'], ask: [], deny: [] },
        project: { allow: ['Hook(skill:*)'], ask: [], deny: [] }, // project allow 已降级（见下），但 local 先命中
      })),
    ).toBe('allow')
  })

  it('安全审阅 P1：project 层 Hook allow 降级 ask（仓库分发的预授权不可信）', () => {
    // 精确与通配两种形态都降级
    expect(
      evalPermission('Hook(skill:foo)', layers({ project: { allow: ['Hook(skill:foo)'], ask: [], deny: [] } })),
    ).toBe('ask')
    expect(
      evalPermission('Hook(skill:foo)', layers({ project: { allow: ['Hook(skill:*)'], ask: [], deny: [] } })),
    ).toBe('ask')
    // 恶意仓库 project 预授权 + 用户层不知情：仍 ask（不再被 project 层 allow 短路）
    expect(
      evalPermission('Hook(skill:evil)', layers({
        project: { allow: ['Hook(skill:*)'], ask: [], deny: [] },
        user: { allow: [], ask: [], deny: [] },
      })),
    ).toBe('ask')
  })

  it('user/local 层 Hook allow 不受降级影响（用户亲手配置/交互式记住，可信）', () => {
    expect(
      evalPermission('Hook(skill:foo)', layers({ user: { allow: ['Hook(skill:*)'], ask: [], deny: [] } })),
    ).toBe('allow')
    expect(
      evalPermission('Hook(skill:foo)', layers({ local: { allow: ['Hook(skill:foo)'], ask: [], deny: [] } })),
    ).toBe('allow')
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

  it('安全审阅 P2：文件损坏（非法 JSON）→ throw 且原内容不被覆写', () => {
    mkdirSync(join(dir, '.ecode'), { recursive: true })
    const file = join(dir, '.ecode', 'settings.local.json')
    writeFileSync(file, '{broken json')
    expect(() => saveLocalPermission(dir, 'allow', 'Hook(skill:x)')).toThrow('settings.local.json')
    expect(readFileSync(file, 'utf8')).toBe('{broken json') // 损坏文件原样保留
  })

  it('安全审阅 P2：原子替换——写入后目录内无 .tmp 残留', () => {
    saveLocalPermission(dir, 'allow', 'Hook(skill:x)')
    const files = readdirSync(join(dir, '.ecode'))
    expect(files).toEqual(['settings.local.json'])
  })
})

describe('M14-C3② asker 键控（多宿主不串台）', () => {
  it('两会话各挂各键：ask 按键路由命中各自的 handler；无挂载键 fail-closed 返回 null', async () => {
    const seen: string[] = []
    setPermissionAsker('sess-a', async (owner) => {
      seen.push(`a:${owner}`)
      return { allow: true, remember: false }
    })
    setPermissionAsker('sess-b', async (owner) => {
      seen.push(`b:${owner}`)
      return { allow: false, remember: false }
    })
    const ra = await askPermissionInteractive('sess-a', 'skill:foo', 'PreToolUse')
    expect(ra).toEqual({ allow: true, remember: false })
    const rb = await askPermissionInteractive('sess-b', 'skill:foo', 'PreToolUse')
    expect(rb).toEqual({ allow: false, remember: false })
    expect(seen).toEqual(['a:skill:foo', 'b:skill:foo']) // 各走各桥，无交叉
    expect(await askPermissionInteractive('sess-none', 'x', 'y')).toBeNull() // 无挂载 → fail-closed
  })

  it('null 卸载指定键；他键不受影响；归属守卫只读口径', async () => {
    setPermissionAsker('k1', async () => ({ allow: true, remember: false }))
    setPermissionAsker('k2', async () => ({ allow: true, remember: false }))
    expect(currentPermissionAsker('k1')).not.toBeNull()
    setPermissionAsker('k1', null)
    expect(currentPermissionAsker('k1')).toBeNull()
    expect(currentPermissionAsker('k2')).not.toBeNull() // 卸 K1 不动 K2
    setPermissionAsker('k2', null)
  })
})
