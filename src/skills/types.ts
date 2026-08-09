// Skills（支点 13 阶段1）类型定义。
//
// skill = 可复用的「菜谱」SKILL.md（frontmatter 元数据 + 正文步骤），agent 启动看 catalog，
// 手动 /skill 或 LLM 自动匹配触发，按菜谱执行。懒加载：catalog 只 name+description（防 prompt
// 爆炸），正文 body 触发才读（getSkillBody）。
//
// 设计对齐子代理（支点9 AgentDefinition）：同为 frontmatter .md + 两层作用域 + 懒加载 catalog。
// 区别：skill 是「流程菜谱」（注入对话交主 LLM 跑），agent 是「分身」（独立上下文只回结论）。
import type { ModelAlias } from '../router/types.js';

export type SkillSource = 'user' | 'project' | 'system';

export interface SkillDefinition {
  /** frontmatter name（缺则用文件名 stem）；LLM 匹配 / catalog 展示 / /skill 调用键。 */
  name: string;
  /** frontmatter：何时用这个菜谱（LLM 自动匹配依据 + catalog 展示）。 */
  description: string;
  /** frontmatter：收紧工具子集（呼应子代理 tools，权限⊆）。 */
  allowedTools?: string[];
  /** frontmatter：指定模型 alias（路由细粒度入口，支点22-T2，解耦底层模型）。 */
  model?: ModelAlias;
  /** SKILL.md 正文（人设/步骤，懒加载：catalog 不含，/skill 触发才读注入对话）。 */
  body: string;
  /** 来源作用域：user（~/.ecode/skills）/ project（<cwd>/.ecode/skills）/ system（内置）。 */
  source: SkillSource;
  /** 文件绝对路径（调试 / name 兜底用 stem）。 */
  filePath: string;
}
