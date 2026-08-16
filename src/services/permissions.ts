/**
 * 权限规则引擎首步（M9-P5 / M8 §11.1-11.2 设计）：Hook(owner) 三态 + 三层存储求值。
 *
 * 规则字符串式（可手编可 UI 列）："Hook(skill:foo)" / "Hook(plugin:bar@mkt)" /
 * "Hook(skill:*)"（prefix 通配）。三态：allow / ask / deny——ask 是一等状态（显式每次问），
 * deny 任意层终局。
 *
 * 存储三层（M8 §11.2）：~/.ecode/settings.json（user）< <proj>/.ecode/settings.json（project）
 * < <proj>/.ecode/settings.local.json（local——交互式"记住"的默认落点，gitignore 不污染团队）。
 * 求值：deny 任一层 → deny；否则最高层（local > project > user）首个命中规则胜；无规则 → ask（默认问）。
 *
 * 首步只做 Hook(owner)（扩展源 hook 首次执行前门控）；Skill/Plugin/Mcp 四维与 /permissions
 * UI 后置（M8 §11.4 分阶段）。用户源 hooks（config.json）不问——所有者侧非被管控对象。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type PermissionBehavior = 'allow' | 'ask' | 'deny'

export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

/** 三层（缺文件/损坏 → 该层无规则，容错不炸） */
export interface PermissionLayers {
  local?: PermissionRules
  project?: PermissionRules
  user?: PermissionRules
}

const EMPTY_RULES: PermissionRules = { allow: [], ask: [], deny: [] }

/**
 * 规则匹配资源："Hook(skill:foo)" 精确命中；"Hook(skill:*)" 括号内参数尾 `*` 通配
 * （资源类型 Hook/Skill/... 必须相同）。非 `Type(param)` 形态不匹配（防御）。
 */
export function ruleMatches(rule: string, resource: string): boolean {
  if (rule === resource) return true
  const rm = /^(\w+)\((.*)\)$/.exec(rule)
  const em = /^(\w+)\((.*)\)$/.exec(resource)
  if (rm === null || em === null) return false
  if (rm[1] !== em[1]) return false // 资源类型不同
  const param = rm[2]
  if (!param.endsWith('*')) return false
  return em[2].startsWith(param.slice(0, -1))
}

/** 求值：deny 任一层终局；否则 local > project > user 首个命中；无规则默认 ask。 */
export function evalPermission(resource: string, layers: PermissionLayers): PermissionBehavior {
  const order: Array<PermissionRules | undefined> = [layers.local, layers.project, layers.user]
  if (order.some((l) => l !== undefined && l.deny.some((r) => ruleMatches(r, resource)))) return 'deny'
  for (const layer of order) {
    if (layer === undefined) continue
    for (const behavior of ['allow', 'ask'] as const) {
      if (layer[behavior].some((r) => ruleMatches(r, resource))) return behavior
    }
  }
  return 'ask'
}

function readRules(file: string): PermissionRules | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: Partial<PermissionRules> }
    const p = raw.permissions
    if (p === undefined) return undefined
    return {
      allow: Array.isArray(p.allow) ? p.allow : [],
      ask: Array.isArray(p.ask) ? p.ask : [],
      deny: Array.isArray(p.deny) ? p.deny : [],
    }
  } catch {
    return undefined
  }
}

/** 三层加载（cwd = 项目根）。 */
export function loadPermissionLayers(cwd: string): PermissionLayers {
  return {
    local: readRules(join(cwd, '.ecode', 'settings.local.json')),
    project: readRules(join(cwd, '.ecode', 'settings.json')),
    user: readRules(join(homedir(), '.ecode', 'settings.json')),
  }
}

/** 交互式"记住"落 local 层（读改写保留其他键；去重）。 */
export function saveLocalPermission(cwd: string, behavior: 'allow' | 'deny', rule: string): void {
  const file = join(cwd, '.ecode', 'settings.local.json')
  let doc: { permissions?: Partial<PermissionRules> } = {}
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as typeof doc
  } catch {
    // 不存在/损坏 → 新建
  }
  const perms = doc.permissions ?? {}
  const list = Array.isArray(perms[behavior]) ? [...(perms[behavior] as string[])] : []
  if (!list.includes(rule)) list.push(rule)
  perms[behavior] = list
  doc.permissions = perms
  mkdirSync(join(cwd, '.ecode'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/** local 层文件是否存在（UI 提示用；MVP 未用，接口位留） */
export function localPermissionExists(cwd: string): boolean {
  return existsSync(join(cwd, '.ecode', 'settings.local.json'))
}

// —— ask 交互桥（askUserBridge 同款模式：services 层无 UI，宿主注入确认弹窗） ——

export interface PermissionAnswer {
  allow: boolean
  remember: boolean
}

let asker: ((owner: string, event: string) => Promise<PermissionAnswer>) | null = null

/** TuiApp 挂载时注入（ConfirmPrompt 弹窗）；卸载置 null（argv/测试：ask 默认拒绝，fail-closed） */
export function setPermissionAsker(h: ((owner: string, event: string) => Promise<PermissionAnswer>) | null): void {
  asker = h
}

export async function askPermissionInteractive(owner: string, event: string): Promise<PermissionAnswer | null> {
  if (asker === null) return null
  return asker(owner, event)
}

export { EMPTY_RULES }
