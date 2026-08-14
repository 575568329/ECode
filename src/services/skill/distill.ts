/**
 * Skill 蒸馏命令层逻辑（M6 S-P7 / S8.3 L2 半自动）。
 *
 * 流程：读会话 → LLM 一次性起草（SkillCandidate）→ 预览确认 → install。
 * 同名已存在 → 升级模式：LLM merger 三态判定（add/equal/conflict）→ 冲突裁决 → install。
 *
 * 职责边界（v6 审阅拆层）：本文件只做 LLM 调用与协议解析（可 mock 单测）；
 * 确定性落盘在 SkillRegistry.install；预览/裁决交互在 TuiApp（confirm/select overlay）。
 * LLM 只判断不拼盘——merger 产出逐 section 判定，最终文件由 install 的 mergeBody 组装。
 */

import type { LLMProvider, LLMProviderRunRequest, ProviderReq } from '../../providers/interface.js'
import type { Message } from '../../core/types.js'
import type { SkillCandidate, SkillInfo, SectionDecision } from '../skill.js'
import { SKILL_NAME_RE, splitSections } from '../skill.js'
import { serializeMessage, TOOL_RESULT_MAX_CHARS } from '../compaction/summarize.js'

/** 无 tools 单发：流式收全文（error delta 抛错，与 callSummary 同模式）。 */
export async function callLLM(
  provider: LLMProvider,
  providerReq: ProviderReq,
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const req: LLMProviderRunRequest = {
    name: providerReq.name,
    baseURL: providerReq.baseURL,
    apiKey: providerReq.apiKey,
    model: providerReq.model,
    system,
    messages,
    tools: [],
    ...(signal !== undefined ? { signal } : {}),
  }
  let raw = ''
  for await (const d of provider.run(req)) {
    if (d.type === 'text') raw += d.text
    if (d.type === 'error') throw new Error(`蒸馏 LLM 流内错误: ${d.error.message}`)
  }
  return raw
}

/** 会话 → 转写文本（复用 M5 序列化：tool result 截断防大输出打爆起草 prompt）。 */
export function serializeSession(messages: Message[]): string {
  return messages.map((m) => serializeMessage(m)).join('\n\n').slice(0, 60_000)
}

// —— 起草（创建路径）—— //

export const DRAFT_SYSTEM = `你是一个 Skill 起草器。从用户与 AI 助手的对话中提炼一个可复用的工作流技能（Skill）。
只输出一个 JSON 代码块，不要输出其他内容。格式：
\`\`\`json
{
  "name": "小写kebab-case名（^[a-z0-9]([a-z0-9-]*[a-z0-9])?$，≤64字符）",
  "description": "何时用+做什么（触发命脉：模型倾向 under-trigger，写激进些——'用户提到 X 时即使没明说也调用'，≤1024字符）",
  "when_to_use": "触发线索（可选）",
  "body": "# 技能名\\n\\n## 步骤\\n\\n1. ...（markdown，含具体步骤/命令/成功判据，建议 <100 行）"
}
\`\`\`
要求：
- 只在对话里确有可复用工作流时产出（没有则输出 {"error": "无可复用工作流"}）
- body 用 ## 分节（升级合并按节进行）
- 步骤要具体可执行（含实际命令/路径），不要空话`

export function buildDraftUser(sessionText: string): string {
  return `以下是会话记录（tool 输出已截断到 ${TOOL_RESULT_MAX_CHARS} 字符）：

${sessionText}

请起草 Skill（JSON）。`
}

export function parseCandidate(raw: string): SkillCandidate {
  const obj = extractJson(raw) as Record<string, unknown>
  if (obj === null || typeof obj !== 'object') throw new Error('起草输出未包含 JSON')
  if (typeof obj['error'] === 'string') throw new Error(`起草失败：${obj['error']}`)
  const name = String(obj['name'] ?? '')
  const description = String(obj['description'] ?? '')
  const body = String(obj['body'] ?? '')
  if (!SKILL_NAME_RE.test(name) || name.length > 64) throw new Error(`起草 name 非法：${name}`)
  if (description.trim() === '' || description.length > 1024) throw new Error('起草 description 为空或超 1024 字符')
  if (body.trim() === '') throw new Error('起草 body 为空')
  return {
    name,
    description,
    whenToUse: obj['when_to_use'] !== undefined ? String(obj['when_to_use']) : undefined,
    body,
  }
}

// —— merger（升级路径）：三态判定协议 —— //

export interface SectionVerdict {
  title: string
  verdict: 'add' | 'equal' | 'conflict'
  /** add/conflict 时的补丁段全文（含 ## 标题行） */
  body?: string
}

export const MERGER_SYSTEM = `你是一个 Skill 升级合并判定器。对比「新候选」与「现有 skill」的 body（按 ## 二级标题分节），
对候选的每个 section 输出三态判定。只输出一个 JSON 代码块：
\`\`\`json
{ "sections": [ { "title": "节标题（## 后的文本）", "verdict": "add|equal|conflict", "body": "该节全文（add/conflict 时必填，equal 省略）" } ] }
\`\`\`
判定标准：
- add：现有 body 没有同名节（新知识，追加）
- equal：与现有同名节内容语义等价（忽略，不重复写）
- conflict：同名节但内容矛盾/更新（需用户裁决）
原则：只追加增量，不重写等价内容。`

export function buildMergerUser(existing: SkillInfo, candidate: SkillCandidate): string {
  return `【现有 skill body】
${existing.body}

【新候选 body】
${candidate.body}

请逐节判定（JSON）。`
}

export function parseMergerVerdicts(raw: string): SectionVerdict[] {
  const obj = extractJson(raw) as { sections?: unknown } | null
  if (obj === null || !Array.isArray(obj.sections)) throw new Error('merger 输出未包含 sections')
  return obj.sections.map((s) => {
    const sec = s as Record<string, unknown>
    const verdict = String(sec['verdict'])
    if (verdict !== 'add' && verdict !== 'equal' && verdict !== 'conflict') {
      throw new Error(`merger verdict 非法：${verdict}`)
    }
    return { title: String(sec['title'] ?? ''), verdict, body: sec['body'] !== undefined ? String(sec['body']) : undefined }
  })
}

/** 冲突节标题（裁决对象）。 */
export function conflictTitles(verdicts: SectionVerdict[]): string[] {
  return verdicts.filter((v) => v.verdict === 'conflict').map((v) => v.title)
}

/**
 * 裁决 → install 决策：equal 全部 keep（等价不重写）；add 默认 adopt；
 * conflict 按用户裁决（keep-all / adopt-all，MVP 单层批量裁决）。
 * add 的 body 已在 verdicts 里，但 install 吃的是完整 candidate.body + decisions——
 * 这里把 merger 判定翻译回「候选 body 的 section 子集」：keep 掉 equal 节，
 * conflict 节按裁决 keep/adopt。
 */
export function decisionsFromVerdicts(
  candidateBody: string,
  verdicts: SectionVerdict[],
  conflictResolution: 'keep' | 'adopt',
): SectionDecision[] {
  const decisions: SectionDecision[] = []
  for (const v of verdicts) {
    if (v.verdict === 'equal') decisions.push({ title: v.title, verdict: 'keep' })
    if (v.verdict === 'conflict') decisions.push({ title: v.title, verdict: conflictResolution })
  }
  // merger 没判到的候选节（LLM 漏判）默认 adopt（install 默认行为），无需生成决策
  void candidateBody
  return decisions
}

// —— 预览渲染（confirm 的 preview 文本）—— //

export function renderCreatePreview(c: SkillCandidate): string {
  return [
    `将创建 skill「${c.name}」`,
    `描述：${c.description}`,
    c.whenToUse !== undefined ? `触发：${c.whenToUse}` : '',
    '',
    '--- body 预览 ---',
    c.body.slice(0, 2000),
    c.body.length > 2000 ? '\n…（超 2000 字符截断，全文落盘）' : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

export function renderUpgradePreview(
  c: SkillCandidate,
  verdicts: SectionVerdict[],
  conflictResolution: 'keep' | 'adopt',
): string {
  const add = verdicts.filter((v) => v.verdict === 'add').map((v) => `+ ${v.title}`)
  const eq = verdicts.filter((v) => v.verdict === 'equal').map((v) => `= ${v.title}（等价，跳过）`)
  const conflict = verdicts
    .filter((v) => v.verdict === 'conflict')
    .map((v) => `! ${v.title} → ${conflictResolution === 'adopt' ? '采用新' : '保留现有'}`)
  return [
    `将升级 skill「${c.name}」（旧版自动备份到 versions/）`,
    `描述：${c.description}`,
    '',
    '--- 变更 ---',
    ...add,
    ...eq,
    ...conflict,
  ].join('\n')
}

/** 升级路径重写候选 body：只保留 add + 被裁决 adopt 的 conflict 节（install 拿干净的补丁）。 */
export function patchBodyFromVerdicts(candidateBody: string, verdicts: SectionVerdict[], conflictResolution: 'keep' | 'adopt'): string {
  const keep = new Set(
    verdicts
      .filter((v) => v.verdict === 'equal' || (v.verdict === 'conflict' && conflictResolution === 'keep'))
      .map((v) => v.title),
  )
  // verdicts 里 add/conflict 自带 body（LLM 已给），优先用；漏 body 的回退从候选 body 切
  const fromCandidate = new Map(splitSections(candidateBody).sections.map((s) => [s.title, s.text]))
  const parts: string[] = []
  const preamble = splitSections(candidateBody).preamble
  if (preamble !== '') parts.push(preamble)
  for (const v of verdicts) {
    if (keep.has(v.title)) continue
    const text = v.body !== undefined && v.body !== '' ? v.body : fromCandidate.get(v.title)
    if (text !== undefined) parts.push(text.trim())
  }
  return parts.join('\n\n') + '\n'
}

// —— JSON 提取（兼容 ```json 围栏与裸 JSON）—— //

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced !== null ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
