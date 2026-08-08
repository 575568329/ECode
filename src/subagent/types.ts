// 子代理（支点 9）类型定义。
//
// 子代理 = 主代理派出的「侦察兵」分身，独立跑一轮 runAgentStream（独立上下文），
// 只回最终结论文本（黑盒，不泄露中间 tool 调用到主上下文）。
//
// 人设来自 .ecode/agents/*.md（frontmatter + 正文），loader.ts 解析成本类型。

/**
 * 一个子代理人设（.ecode/agents/<name>.md 解析结果）。
 * - name：文件名 stem（主 LLM 据此在 Task 工具 input.agent 里点名派遣）。
 * - description：何时派这个分身（注入 system prompt 的 catalog，主 LLM 据此决定）。
 * - tools：限定工具子集（收紧权限；如 ['read_file','grep','glob'] 只读）。undefined = 全工具。
 * - model：指定模型（支点 22 模型路由的前置字段，本里程碑 loader 解析但路由留 M6+）。
 * - systemPrompt：.md 正文（人设指令），作为子代理 runAgentStream 的 system。
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
}
