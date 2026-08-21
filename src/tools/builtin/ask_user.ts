/**
 * ask_user 工具（M8 §2，M8-D3/D4/D5）：模型主动信息收集——模糊需求弹选项面板，
 * 不进审批语义（ConfirmPrompt=副作用授权；ask_user=提问，readonly 免确认）。
 *
 * 回传格式（对模型最友好）：User has answered your questions: "q"="a, b".
 * 防滥用三支柱写进 description：能推断就别问 / 先调查再问 / 不重复问。
 */

import type { Tool } from '../interface.js'
import { askUserViaUI, askUserInteractive } from './askUserBridge.js'

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  /** 完整问句（？结尾；multiSelect 时措辞为「选哪些」） */
  question: string
  /** 短标签 ≤12 字符（多问题时 chip 导航用） */
  header: string
  options: AskUserOption[]
  multiSelect?: boolean
}

/** 面板裁决：answers 与 questions 等长（多选为 label 数组）；cancel=用户取消；non-interactive=无 UI。 */
export type AskUserResult =
  | { kind: 'answers'; answers: Array<string | string[]> }
  | { kind: 'cancel' }
  | { kind: 'non-interactive' }

/** AJV 之外的跨项校验（schema 表达不了唯一性）：问题文本全局唯一、每题 label 唯一。 */
export function validateAskUserInput(questions: AskUserQuestion[]): string | null {
  const seenQ = new Set<string>()
  for (const q of questions) {
    if (q.header.length > 12) return `header「${q.header}」超过 12 字符`
    if (seenQ.has(q.question)) return `问题文本重复：「${q.question}」`
    seenQ.add(q.question)
    const labels = new Set<string>()
    for (const o of q.options) {
      if (labels.has(o.label)) return `问题「${q.header}」的选项重复：「${o.label}」`
      labels.add(o.label)
    }
  }
  return null
}

/** 答案 → 回传文本（多选逗号连接）。 */
export function renderAnswers(questions: AskUserQuestion[], answers: Array<string | string[]>): string {
  const lines = questions.map((q, i) => `"${q.question}"="${Array.isArray(answers[i]) ? (answers[i] as string[]).join(', ') : (answers[i] as string)}"`)
  return `User has answered your questions: ${lines.join('; ')}. You can now continue with the user's answers in mind.`
}

export const askUserTool: Tool = {
  name: 'ask_user',
  description: `向用户提问收集信息（选项框）。仅当需求模糊、且自己调查（读代码/grep）后仍无法推断时才调用；能采用合理默认就直接做并说明，不要问。一次最多一组问题（1-4 问 × 每题 2-4 选项）；推荐项放第一个并在 label 加 (Recommended)；用户始终可选 Other 自由输入，不要生成兜底选项。`,
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          required: ['question', 'header', 'options'],
          properties: {
            question: { type: 'string', description: '完整问句，清晰具体，以？结尾' },
            header: { type: 'string', maxLength: 12, description: '短标签（≤12 字符，chip 导航用）' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', description: '1-5 词显示文本' },
                  description: { type: 'string', description: '选项含义/trade-off 说明' },
                },
              },
            },
            multiSelect: { type: 'boolean', description: '多选（默认 false）' },
          },
        },
      },
    },
    required: ['questions'],
  },
  readonly: true,

  async execute(args, ctx) {
    const { questions } = args as { questions: AskUserQuestion[] }
    const invalid = validateAskUserInput(questions)
    if (invalid !== null) {
      return { content: `ask_user 入参校验失败：${invalid}。请修正后重试（每题选项不重复、问题文本不重复、header ≤12 字符）。`, is_error: true }
    }
    // B8.2：宿主会话端口优先（多宿主各自的 broker）；模块桥降为单会话兜底
    const sessAsk = (ctx as { session?: { askUser?(q: unknown[]): Promise<unknown> } }).session?.askUser
    if (sessAsk !== undefined) {
      const r = await sessAsk(questions)
      if (r === null || r === undefined) {
        return { content: '当前为非交互环境，无法弹出选项面板。请基于上下文选择最合理的默认方案继续执行，并向用户说明你采用的假设。' }
      }
      return { content: `用户已作答：${JSON.stringify((r as { answers?: unknown }).answers ?? r)}` }
    }
    if (!askUserInteractive()) {
      // M8-D5：argv 单次模式/无 UI——返回提示让模型自行决策，不 is_error 挂死
      return {
        content:
          '当前为非交互环境，无法弹出选项面板。请基于上下文选择最合理的默认方案继续执行，并向用户说明你采用的假设。',
      }
    }
    const result = await askUserViaUI(questions)
    if (result.kind !== 'answers') {
      return {
        content:
          result.kind === 'cancel'
            ? '用户取消了提问。请改用合理默认继续（并说明），或换一种方式推进任务。'
            : '当前为非交互环境，无法弹出选项面板。请基于上下文选择最合理的默认方案继续执行，并向用户说明你采用的假设。',
      }
    }
    return { content: renderAnswers(questions, result.answers) }
  },
}
