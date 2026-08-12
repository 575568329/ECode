/**
 * LLMProvider Registry 实现（按 type 注册/查找）。
 *
 * 启动期 register 各 Provider 实现；AgentLoop 每轮 getByType(type) 取实现。
 */

import type { LLMProvider, LLMProviderRegistry } from './interface.js'

export class LLMProviderRegistryImpl implements LLMProviderRegistry {
  private readonly map = new Map<string, LLMProvider>()

  register(p: LLMProvider): void {
    this.map.set(p.type, p)
  }

  getByType(type: string): LLMProvider {
    const p = this.map.get(type)
    if (!p) {
      // 配置错误（type 未注册），启动期即应暴露，fatal
      throw new Error(`[PROVIDER_NOT_FOUND] 未注册的 provider type: ${type}`)
    }
    return p
  }
}
