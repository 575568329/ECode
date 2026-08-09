// ============================================================
// 模型路由类型（支点22）—— alias 解耦 frontmatter model 字段与底层模型
// ============================================================
//
// 设计：alias = 逻辑名（cheap/strong/reasoning），Skill/agent frontmatter 写 alias，
// 换底层模型只改 config 的 alias 映射，不改 frontmatter（支点22-T2 配置解耦）。
// 路由用规则映射（非 LLM 决策，省决策成本）：场景 → alias → resolveAlias → 具体 provider+model。
// 阶段0 只落 types + resolver 纯函数；config.json routing 块读取 + 场景规则映射留阶段3（rules.ts/config.ts）。

/**
 * 模型逻辑别名。
 * cheap/strong/reasoning 为内置语义名；`(string & {})` 允许用户自定义任意字符串
 * （TS 技巧：与字面量联合后 IDE 仍对已知名自动补全，同时开放任意扩展）。
 */
export type ModelAlias = 'cheap' | 'strong' | 'reasoning' | (string & {});

/** alias → 具体模型落点（config.json routing.aliases 一条：{ provider, model }）。 */
export interface AliasTarget {
  provider: string;
  model: string;
}

/** 路由触发场景（四触发点：子代理派发 / 上下文压缩 / Skill 执行 / 全局主对话）。 */
export type RoutingScenario = 'subagent' | 'compress' | 'skill' | 'global';

/** 场景规则：某场景派哪个 alias（阶段3 rules.ts 用，阶段0 预留契约）。 */
export interface RoutingRule {
  scenario: RoutingScenario;
  alias: ModelAlias;
}
