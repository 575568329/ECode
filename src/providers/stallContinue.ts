/**
 * 流停滞自动续写策略（2026-09-03：「写不了」问题根治——超长单参数生成 + 大上下文场景下
 * 端点易中途断流，旧行为「有产出即终止」让长文档写入永远失败：每次重发都从头写、在同一处断）。
 *
 * 黏连安全设计（对标 aider reflection / Atlassian Forge 不完整响应恢复）：
 * 旧「有产出不重试」防的是「半截+完整重答」两份内容黏连（retryable 重发=重新生成整条消息，
 * 消费方拿到重复前缀）。续写不同——半截文本固化为 assistant 前缀，续写请求只产出**接续内容**
 * （user 指令钉死「不得重复」），合并后语义等价一次完整生成，两份内容天然不重叠。
 *
 * 边界（回退 STREAM_STALL 错误，保持旧终态）：
 * - 流中出现过 thinking / tool_use delta：半截 tool_use JSON 固化不安全（参数截断无法补齐）、
 *   thinking 前缀续写语义不明——工具与思考阶段的停滞不归续写管；
 * - 续写自身再停滞：连续 2 次续写后放弃（MAX_CONTINUATIONS），总轮数上限防预算失控；
 * - 用户已中断：任何续写都不发起（中断优先，与 stall 重试同守卫）。
 */

/** 续写上限（首次停滞 1 次续写 + 续写停滞再 1 次 = 单次 run 至多 3 个请求段） */
export const MAX_STALL_CONTINUATIONS = 2

/** 停滞续写的请求变换（两 provider 共用单源）：半截文本固化为 assistant 前缀 + user 续写指令。
 *  原消息序列不动（只追加），后续段请求 = 原请求 + [assistant(半截), user(续写指令)]；
 *  accumulatedText=''（首次请求）原样返回。 */
export function stallContinueReq<M extends { role: string; content: unknown }>(
  req: { messages: M[] },
  accumulatedText: string,
): { messages: M[] } {
  if (accumulatedText === '') return req
  return {
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: [{ type: 'text', text: accumulatedText }] } as unknown as M,
      { role: 'user', content: [{ type: 'text', text: continuationPrompt(accumulatedText) }] } as unknown as M,
    ],
  }
}

/** 续写指令（拼在半截内容之后的 user 消息；措辞钉死「接续/禁止重复」——续写质量的关键约束） */
export function continuationPrompt(head: string): string {
  return [
    '[系统续写] 你上一条回复在传输中于以下内容后中断：',
    '```',
    head.length > 200 ? `…${head.slice(-200)}` : head,
    '```',
    '请从中断处直接继续输出剩余内容。严禁重复任何已输出的文字（含上述引文）；无需任何开场白或确认，直接续写。',
  ].join('\n')
}

/** 停滞续写判定（纯函数）：该停滞场景走「续写」还是回退旧「STREAM_STALL 终止」。
 *  producedText=本段流出的纯文本累计；sawStructured=出现过 thinking/tool_use_* delta；
 *  continuationsUsed=已执行的续写次数。 */
export function shouldContinueAfterStall(input: {
  producedText: string
  sawStructured: boolean
  continuationsUsed: number
  userAborted: boolean
}): boolean {
  if (input.userAborted) return false
  if (input.continuationsUsed >= MAX_STALL_CONTINUATIONS) return false
  if (input.sawStructured) return false // 半截 tool_use/thinking 固化不安全——保持旧终态
  return input.producedText !== '' // 零产出场景仍走既有「静默重试 1 次」路径（与本策略无关）
}
