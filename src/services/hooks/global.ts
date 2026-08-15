/**
 * 全局扩展 hooks 注册表（H1 源 2 的进程级实例）。
 *
 * 沿用 M6 skillRegistry 的全局单例先例：SkillTool（静态 Tool 对象）与 TuiApp
 * （手动触发面）都要向扩展注册表写入，经全局实例避免依赖注入穿透 Tool 边界。
 * makeDeps 用它构造 HookRunner（唯一消费方）。
 */

import { ExtensionHooksRegistry } from './registry.js'
import type { HookSpec } from './types.js'

export const globalExtensionHooks = new ExtensionHooksRegistry()

/** skill 触发（LLM 面或手动面）→ 注册其 hooks（owner=skill:<name>，会话级）。 */
export function registerSkillHooks(name: string, hooks: HookSpec[]): void {
  if (hooks.length === 0) return
  globalExtensionHooks.register(`skill:${name}`, hooks)
}

/** 注销单个 skill 的 hooks（skill 删除/注销时）。 */
export function unregisterSkillHooks(name: string): void {
  globalExtensionHooks.unregister(`skill:${name}`)
}

/** 注销全部 skill hooks（会话级清理：/clear、restoreSession 起新会话）。 */
export function unregisterAllSkillHooks(): void {
  for (const e of globalExtensionHooks.entries()) {
    if (e.owner.startsWith('skill:')) globalExtensionHooks.unregister(e.owner)
  }
}
