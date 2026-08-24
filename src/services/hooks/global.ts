/**
 * 扩展 hooks 注册表（H1 源 2）。
 *
 * M13-W1 前是进程级单例：多项目下 A 项目 /clear 清掉 B 项目的 skill hooks（串台）。
 * 现收敛为实例制：ProjectHost 各持 ExtensionHooksRegistry + SkillHooksPort，
 * HookRunner 消费项目级实例；模块级 globalExtensionHooks 降为 REPL/argv 单会话兜底
 * （TUI 组件的模块直读路径在其单项目形态下与项目实例同源——cli 传同一引用）。
 */

import { ExtensionHooksRegistry } from './registry.js'
import type { HookSpec } from './types.js'

export const globalExtensionHooks = new ExtensionHooksRegistry()

/** skill hooks 写端口（按 registry 实例绑定——项目级隔离的写入面） */
export interface SkillHooksPort {
  register(name: string, hooks: HookSpec[]): void
  unregister(name: string): void
  unregisterAll(): void
}

/** 把端口绑到指定 registry 实例（ProjectHost 每项目一个；模块级兜底用 globalExtensionHooks） */
export function makeSkillHooksPort(registry: ExtensionHooksRegistry): SkillHooksPort {
  return {
    register(name, hooks) {
      if (hooks.length === 0) return
      registry.register(`skill:${name}`, hooks)
    },
    unregister(name) {
      registry.unregister(`skill:${name}`)
    },
    unregisterAll() {
      for (const e of registry.entries()) {
        if (e.owner.startsWith('skill:')) registry.unregister(e.owner)
      }
    },
  }
}

/** 模块级兜底端口（REPL/argv 单会话——与 globalExtensionHooks 同源） */
export const globalSkillHooks: SkillHooksPort = makeSkillHooksPort(globalExtensionHooks)

/** 兼容保留：旧调用面直接用模块端口（skill 工具无 ctx 时 / 旧测试） */
export function registerSkillHooks(name: string, hooks: HookSpec[]): void {
  globalSkillHooks.register(name, hooks)
}

export function unregisterSkillHooks(name: string): void {
  globalSkillHooks.unregister(name)
}

export function unregisterAllSkillHooks(): void {
  globalSkillHooks.unregisterAll()
}
