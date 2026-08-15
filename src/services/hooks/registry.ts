/**
 * 扩展源 hooks 注册表（H1 源 2，M7-D10）。
 *
 * 内存注册表：skill frontmatter hooks（会话级）与 plugin hooks.json（持久级）都经
 * register(owner, …) 进来，**永不写入 config.json**——用户改 config 不触碰这里，
 * 只有删除/注销才 unregister（分层铁律）。
 *
 * rebuild 是原子替换（clear-then-register 一步完成，防遍历到半空集）。
 */

import type { HookSpec } from './types.js'

export interface OwnedHooks {
  owner: string
  hooks: HookSpec[]
}

export class ExtensionHooksRegistry {
  private owners = new Map<string, HookSpec[]>()

  /** 注册/覆盖一个 owner 的 hooks（owner = 'skill:xxx' | 'plugin:yyy@mkt'）。 */
  register(owner: string, hooks: HookSpec[]): void {
    if (hooks.length === 0) {
      this.unregister(owner)
      return
    }
    this.owners.set(owner, [...hooks])
  }

  /** 注销（仅删除/注销时调：plugin uninstall/disable、skill 会话结束）。 */
  unregister(owner: string): void {
    this.owners.delete(owner)
  }

  /** 原子重建全部（随扩展安装集——先清空再注入，单次赋值无中间态）。 */
  rebuild(entries: OwnedHooks[]): void {
    this.owners = new Map(entries.map((e) => [e.owner, [...e.hooks]]))
  }

  entries(): OwnedHooks[] {
    return [...this.owners.entries()].map(([owner, hooks]) => ({ owner, hooks: [...hooks] }))
  }

  /** 全部展平（分发时与用户源合并）。 */
  specs(): HookSpec[] {
    return this.entries().flatMap((e) => e.hooks)
  }
}
