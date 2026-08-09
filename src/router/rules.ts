// ============================================================
// 模型路由场景规则（支点22）—— 场景 → alias → 具体 provider+model
// ============================================================
//
// 在阶段0 resolveAlias（alias→落点纯映射）之上，加「场景」一维：
//   优先级：显式 frontmatter model（场景对应字段）> 场景规则（rules[scenario]）> global default。
// 纯函数零副作用：config.json routing 块的读取由 router/config.ts（IO 包装）负责，
// 规避 providers/config 单例缓存的测试困境。本函数只接收已解析的 RoutingConfig。
import { resolveAlias } from './resolver.js';
import type { ModelAlias, AliasTarget, RoutingScenario } from './types.js';

/** 路由配置（router/config.ts 从 config.json routing 块读出，传给本纯函数）。 */
export interface RoutingConfig {
  /** alias → 模型落点表（config.json routing.aliases）。 */
  aliases: Record<string, AliasTarget>;
  /** 场景规则：某场景派哪个 alias（config.json routing.rules）。 */
  rules: Partial<Record<RoutingScenario, ModelAlias>>;
  /** global 回退落点（顶层 defaultModel 解析出的 { provider, model }）。 */
  defaultTarget: AliasTarget;
}

/** 场景上下文：显式 model 字段（优先级最高，覆盖规则）。compress/global 场景无显式来源。 */
export interface ScenarioContext {
  /** 子代理 frontmatter model（仅 scenario=subagent 时生效）。 */
  agentModel?: ModelAlias;
  /** skill frontmatter model（仅 scenario=skill 时生效）。 */
  skillModel?: ModelAlias;
}

/**
 * 解析某场景该派的模型（支点22）。
 *
 * 优先级：显式 frontmatter model（场景对应字段）> 场景规则（rules[scenario]→alias）> global default。
 * alias 未配置 → resolveAlias 回退 defaultTarget（resolver 已守，不崩）。
 *
 * @param scenario 触发场景（subagent 派发 / compress 压缩 / skill 执行 / global 主对话）
 * @param ctx     显式 model（子代理/skill frontmatter）；compress/global 无显式来源
 * @param config  路由配置（aliases + rules + defaultTarget）
 */
export function resolveModelForScenario(
  scenario: RoutingScenario,
  ctx: ScenarioContext | undefined,
  config: RoutingConfig,
): AliasTarget {
  // 显式优先：只有 subagent/skill 场景有 frontmatter model 来源
  const explicitAlias =
    scenario === 'subagent'
      ? ctx?.agentModel
      : scenario === 'skill'
        ? ctx?.skillModel
        : undefined;
  if (explicitAlias) {
    return resolveAlias(explicitAlias, config.aliases, config.defaultTarget);
  }
  // 场景规则：scenario → alias → 落点
  const ruleAlias = config.rules[scenario];
  if (ruleAlias) {
    return resolveAlias(ruleAlias, config.aliases, config.defaultTarget);
  }
  // 全兜底：global default
  return config.defaultTarget;
}
