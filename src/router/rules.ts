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
import { assessComplexity, type Complexity } from './complexity.js';

/** 路由配置（router/config.ts 从 config.json routing 块读出，传给本纯函数）。 */
export interface RoutingConfig {
  /** alias → 模型落点表（config.json routing.aliases）。 */
  aliases: Record<string, AliasTarget>;
  /** 场景规则：某场景派哪个 alias（config.json routing.rules）。 */
  rules: Partial<Record<RoutingScenario, ModelAlias>>;
  /** global 回退落点（顶层 defaultModel 解析出的 { provider, model }）。 */
  defaultTarget: AliasTarget;
  /** 启发式复杂度路由开关（默认 false，向后兼容；§11）。true 时 subagent 按任务难度动态选档。 */
  complexityRouting: boolean;
  /** 复杂度档位 → alias（仅 complexityRouting=true 生效；§11）。 */
  complexity?: Partial<Record<Complexity, ModelAlias>>;
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

/** 子代理路由来源（供 UI 气泡标注，§16.5）。 */
export type RoutingSource = 'persona' | 'complexity' | 'rule' | 'default';

/** resolveModelForSubagent 入参。 */
export interface SubagentRoutingInput {
  /** 人设 frontmatter model（最高优先级）。 */
  personaModel?: ModelAlias;
  /** 子任务描述（供 assessComplexity 评估难度）。 */
  taskDesc: string;
  /** 预估工具数（可选，传给 assessComplexity）。 */
  toolCount?: number;
}

/** resolveModelForSubagent 出参：落点 + 来源（供 UI 标注）。 */
export interface SubagentRoutingResult {
  provider: string;
  model: string;
  source: RoutingSource;
}

/**
 * 子代理路由（R3）：complexityRouting 分支 + 跨 provider 解耦。
 *
 * 优先级：persona.model > complexity 动态档（complexityRouting=true 时）> rules.subagent > default。
 * provider 一律从解析出的 AliasTarget 取（**不继承主 provider**），支持跨 provider 子代理
 * （如 cheap→deepseek 而主=zhipu）。
 *
 * **不改 resolveModelForScenario**（向后兼容 compress/skill/global 场景），仅 subagent 用本函数。
 */
export function resolveModelForSubagent(
  input: SubagentRoutingInput,
  config: RoutingConfig,
): SubagentRoutingResult {
  // 1. persona 显式优先
  if (input.personaModel) {
    const t = resolveAlias(input.personaModel, config.aliases, config.defaultTarget);
    return { provider: t.provider, model: t.model, source: 'persona' };
  }
  // 2. complexityRouting=true → assessComplexity → 档位 alias
  if (config.complexityRouting && config.complexity) {
    const complexity = assessComplexity(input.taskDesc, { toolCount: input.toolCount });
    const alias = config.complexity[complexity];
    if (alias) {
      const t = resolveAlias(alias, config.aliases, config.defaultTarget);
      return { provider: t.provider, model: t.model, source: 'complexity' };
    }
    // 该档未配置 → 落到 rules/default
  }
  // 3. rules.subagent（支点22 静态规则）
  const ruleAlias = config.rules.subagent;
  if (ruleAlias) {
    const t = resolveAlias(ruleAlias, config.aliases, config.defaultTarget);
    return { provider: t.provider, model: t.model, source: 'rule' };
  }
  // 4. 全兜底：global default
  return { provider: config.defaultTarget.provider, model: config.defaultTarget.model, source: 'default' };
}
