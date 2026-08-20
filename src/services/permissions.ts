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

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
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
  const order: Array<{ id: 'local' | 'project' | 'user'; rules: PermissionRules | undefined }> = [
    { id: 'local', rules: layers.local },
    { id: 'project', rules: layers.project },
    { id: 'user', rules: layers.user },
  ]
  if (order.some((l) => l.rules !== undefined && l.rules.deny.some((r) => ruleMatches(r, resource)))) return 'deny'
  for (const layer of order) {
    if (layer.rules === undefined) continue
    for (const behavior of ['allow', 'ask'] as const) {
      const hit = layer.rules[behavior].find((r) => ruleMatches(r, resource))
      if (hit === undefined) continue
      // 安全审阅 P1：project 层（<proj>/.ecode/settings.json 随仓库分发）的 Hook allow 不可信——
      // clone 恶意仓库打开即自动预授权其 hook 执行，用户层无法预先知晓。降级为 ask（显式每次问）；
      // allow 仅 user/local 层可信（用户亲手配置 / 交互式"记住"）。规则类型相同时才可能命中资源，
      // 故以规则自身的 `Hook(` 前缀判定即可覆盖精确与通配两种形态。
      if (behavior === 'allow' && layer.id === 'project' && hit.startsWith('Hook(')) return 'ask'
      return behavior
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
  } catch (e) {
    // 安全审阅 P2：只有 ENOENT（不存在 → 正常新建）可继续；损坏文件（非法 JSON）禁止静默覆写——
    // 损坏文件里可能还有其他键，覆写即无迹丢数据。本模块无 LogStore 注入通路（services 层无
    // UI/日志宿主依赖，与 askUserBridge 同款按需注入模式，MVP 未引入），带上下文重抛给调用方处理。
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`settings.local.json 读取失败（已保留原文件，请手动修复后重试）：${file}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const perms = doc.permissions ?? {}
  const list = Array.isArray(perms[behavior]) ? [...(perms[behavior] as string[])] : []
  if (!list.includes(rule)) list.push(rule)
  perms[behavior] = list
  doc.permissions = perms
  mkdirSync(join(cwd, '.ecode'), { recursive: true })
  // 原子替换（安全审阅 P2）：tmp + rename——直接 writeFileSync 在并发确认（两窗口同时"记住"）
  // 下有丢规则窗口（后写整文件覆盖前写）。tmp 名带 pid+时间戳防两个进程互踩同一 tmp。
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true }) // 半写 tmp 不残留
    throw new Error(`settings.local.json 写入失败：${file}：${e instanceof Error ? e.message : String(e)}`)
  }
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
