// ============================================================
// 模型路由配置读取（支点22）—— config.json routing 块 → RoutingConfig（IO 包装）
// ============================================================
//
// 职责边界（与 rules.ts 分工）：
//   - rules.ts：resolveModelForScenario 纯函数（场景→alias→落点），零 IO，零副作用。
//   - config.ts（本文件）：把 config.json routing 块读出、解析成 RoutingConfig，供纯函数消费。
//
// 分离 IO 与逻辑的目的：规避 providers/config 单例缓存（cachedConfig）的测试困境——
// buildRoutingConfig 是纯函数（注入已加载的 ECodeConfig），可直测；
// getRoutingConfig 是薄生产入口（读单例），不在测试覆盖内（单例难 mock）。
//
// 分层：本文件 import providers/config（上层依赖下层）；providers/config 的 routing 字段
// 用宽松 Record<string, unknown> 持有，不 import router 类型——避免 providers→router 反向耦合。
import { loadConfig } from '../providers/config.js';
import type { ECodeConfig } from '../providers/config.js';
import type { RoutingConfig } from './rules.js';
import type { AliasTarget, ModelAlias, RoutingScenario } from './types.js';
import type { Complexity } from './complexity.js';

/** config.json routing 块原始结构（providers 层宽松持有，本文件强类型解析）。 */
interface RoutingRaw {
  /** alias → 模型落点（与 AliasTarget 同构）。 */
  aliases?: Record<string, AliasTarget>;
  /** 场景 → alias（key 为 RoutingScenario 字面量，宽松 string 兼容用户手写）。 */
  rules?: Partial<Record<RoutingScenario, ModelAlias>>;
  /** 启发式复杂度路由开关（缺省 false）。 */
  complexityRouting?: boolean;
  /** 复杂度档位 → alias。 */
  complexity?: Partial<Record<Complexity, ModelAlias>>;
}

/**
 * 从已加载的 config 解析出 RoutingConfig（纯函数，测试注入 config 避单例困境）。
 *
 * @param cfg 已加载的 ECodeConfig（生产由 loadConfig() 读，测试直接构造）
 * @returns RoutingConfig：aliases（透传）+ rules（透传）+ defaultTarget（顶层 defaultModel 解析）
 */
export function buildRoutingConfig(cfg: ECodeConfig): RoutingConfig {
  const routing = (cfg.routing as RoutingRaw | undefined) ?? {};
  const aliases = routing.aliases ?? {};
  const rules = routing.rules ?? {};
  // defaultTarget：顶层 defaultModel 解析出 { provider, model }；缺失则取首个 model 兜底。
  const defaultModel = cfg.defaultModel ?? Object.keys(cfg.models)[0] ?? '';
  const mc = cfg.models[defaultModel];
  const defaultTarget: AliasTarget = mc
    ? { provider: mc.provider, model: defaultModel }
    : { provider: '', model: defaultModel };
  return {
    aliases,
    rules,
    defaultTarget,
    complexityRouting: routing.complexityRouting ?? false,
    complexity: routing.complexity,
  };
}

/**
 * 生产入口：读单例 config → RoutingConfig（供 runAgentStream 等触发点消费）。
 * 不缓存（routing 配置量小，且 config 单例 cachedConfig 已兜底文件读取开销）。
 */
export function getRoutingConfig(): RoutingConfig {
  return buildRoutingConfig(loadConfig());
}
