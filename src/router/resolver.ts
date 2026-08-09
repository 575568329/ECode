// ============================================================
// 模型路由 alias 解析器（支点22-T3）—— alias → 具体 provider+model
// ============================================================
//
// 复用 providers 层（支点5 已就绪），不新建模型抽象：路由 = alias 到模型 ID 的映射，纯配置。
// 本函数是确定性的纯映射核心；config.json routing.aliases 的读取由阶段3 router/config.ts 做
//（走 resolveDataDir），warn「未配置 alias 回退默认」也由阶段3 IO 包装负责——分离 IO 与逻辑，
// 规避 config 单例的测试困境，本函数零副作用、可直测。
import type { ModelAlias, AliasTarget } from './types.js';

/**
 * 解析 alias 到具体模型落点。
 *
 * @param alias    逻辑别名（cheap/strong/reasoning 或用户自定义字符串）
 * @param aliases  已解析的 alias 表（config.json routing.aliases，key=alias）
 * @param fallback 未命中时的回退落点（调用方传 global defaultModel 解析出的 { provider, model }）
 * @returns 命中则返回表中的映射落点（原对象引用），否则返回 fallback
 */
export function resolveAlias(
  alias: ModelAlias,
  aliases: Record<string, AliasTarget>,
  fallback: AliasTarget,
): AliasTarget {
  return aliases[alias] ?? fallback;
}
