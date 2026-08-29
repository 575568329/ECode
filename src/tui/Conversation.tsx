/**
 * 对话流（最小 Static 方案 + M3 ConfirmPrompt，详设 §7）。
 *
 * 两区模型：Static（历史固化）+ 动态区（当前轮 ①②③ + confirm 弹窗）。
 * confirm 期间（active.confirm 非空）ConfirmPrompt 替代 ③ 流式位（此时流式已停）。
 */
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, Static } from 'ink'
import { ToolGroupView } from './ToolGroupView.js'
import { ConfirmPrompt } from './ConfirmPrompt.js'
import { foldStreamText } from './stream.js'
import { allocateDynamic, useViewport } from './viewport.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import type { CommittedItem, ActiveState, ActiveTool, CommittedToolCall } from './types.js'

/** 用户输入折叠上限（P1-A：防粘贴长代码撑爆动态区） */
const USER_INPUT_MAX_LINES = 2

/** M14-V5 退化保护提示（budget < 12：宁可不显示也不触发 Ink 全清兜底） */
const TOO_SMALL_HINT = '[终端过小，本轮内容已折叠——/output 查看]'

/** 流式灰字占位（commit 前用；超 maxLines 行折叠头部）。
 *  M14-V2：宽度感知物理行折叠（超长单行不再爆物理行）。
 *  M14-V5：maxLines 来自 allocateDynamic 总分配（缺省 3=旧行为）。 */
export function GrayStreaming({ text, maxLines }: { text: string; maxLines?: number }): ReactElement {
  const { columns } = useViewport()
  const { lines, folded, total } = foldStreamText(text, maxLines, columns)
  return (
    <Box flexDirection="column">
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <Text dimColor>{lines.join('\n')}</Text>
    </Box>
  )
}

/** 折叠用户输入到 USER_INPUT_MAX_LINES 行（复用 foldStreamText，P1-A；M14-V2 物理行化） */
function FoldedUserInput({ text }: { text: string }): ReactElement {
  const { columns } = useViewport()
  const { lines, folded, total } = foldStreamText(text, USER_INPUT_MAX_LINES, columns)
  // 排版批②：外层不再叠 marginTop（UserMessage 自带 GAP.block——原双倍空行，差距清单§2 点名）
  return (
    <Box flexDirection="column">
      {folded > 0 && <Text dimColor>↑ {folded} 行已折叠（共 {total} 行）</Text>}
      <UserMessage text={lines.join('\n')} />
    </Box>
  )
}

/** CommittedToolCall[] → ActiveTool[]（Static tool-group 收起态渲染用） */
function callsToTools(calls: CommittedToolCall[]): ActiveTool[] {
  return calls.map((c) => ({
    name: c.use.name,
    use: c.use,
    result: c.result,
    status: c.result.is_error ? ('error' as const) : ('done' as const),
  }))
}

/** 渲染已固化的 CommittedItem（Static 用） */
function renderCommitted(item: CommittedItem): ReactNode {
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} />
    case 'assistant-text':
      return <AssistantMessage text={item.text} />
    case 'tool-group':
      // Static 收起固化（用户拍板：发送新对话后历史默认全收起——▸ preview 单行；
      // 看全文在当前轮 Ctrl+O；历史轮全文回看归输出查看器 M14 挂账）
      return <ToolGroupView tools={callsToTools(item.calls)} />
    case 'compacted':
      // M5 压缩点标记：UI 显示全量原文（投影分离），此处告知模型上下文已被摘要
      return (
        <Text dimColor>
          ⇕ 已压缩（上方 {item.removedCount} 条已摘要进上下文，原文仍显示）
        </Text>
      )
    case 'rewind':
      // M9-P2 回退点标记：下方消息不再进模型上下文（投影截断），原文仍显示
      return (
        <Text dimColor>
          ⇺ 已回退至快照点 {item.seq}（此处之后的对话不再进入上下文，原文仍显示）
        </Text>
      )
  }
}

interface ConversationProps {
  committed: CommittedItem[]
  active: ActiveState
  onToggleTool?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  /** 批2b ①：审批卡字符转发主输入框；②：草稿镜像（非空时单字母快捷失效） */
  onDraftKey?: (input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean }) => void
  draft?: string
  /** 批2b-fix：按键时刻直读主输入框权威值（透传 ConfirmPrompt） */
  readDraft?: () => string
  /** F-31：卡上 Ctrl+C=拒卡+中断整轮（透传 ConfirmPrompt） */
  onInterruptTurn?: () => void
  children?: ReactNode
  /** 审阅 P1-1：条件段活跃态（TasksBar/SubagentBar 各 ≤3 行——allocateDynamic 显式扣减） */
  conditions?: { tasksBar?: boolean; subagentBar?: boolean }
}

export function Conversation({
  committed,
  active,
  onToggleTool,
  onConfirm,
  onCancel,
  onDraftKey,
  draft,
  readDraft,
  onInterruptTurn,
  children,
  conditions,
}: ConversationProps): ReactElement {
  const toolExpanded = active.tools.some(
    (t) => t.use && active.expandedTools.has(t.use.id),
  )
  // 界面批 B1：单工具展开态（expandedTools 只含 1 个且非组级全展——Ctrl+E 路径）。
  // 预算口径与 V2 组展开同：任何展开态 maxTools 收 1（展开工具 expandCap+2 行 + 折叠组头 ≤4 行可控）
  const singleExpanded =
    !toolExpanded && active.expandedTools.size > 0
  // M14-V5（§3.4）总守卫：动态区顶层一次分配（各段独立截断不保证总和 < rows——病态组合
  // 8 组工具×4 行+灰字+输入仍超 24 行终端）；退化态 markdown/工具区不渲染
  const { budget } = useViewport()
  const alloc = allocateDynamic(budget, conditions)
  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item: CommittedItem) => (
          <Box key={item.id}>{renderCommitted(item)}</Box>
        )}
      </Static>
      {/* 动态区：当前轮 ①②③ + confirm */}
      {active.userInput !== '' && <FoldedUserInput text={active.userInput} />}
      {active.tools.length > 0 &&
        (alloc.degraded ? (
          <Text dimColor>{TOO_SMALL_HINT}</Text>
        ) : (
          <ToolGroupView
            tools={active.tools}
            expanded={toolExpanded}
            expandedIds={active.expandedTools}
            done={!active.streaming}
            onToggle={onToggleTool}
            maxTools={toolExpanded || singleExpanded ? Math.min(alloc.toolGroupCap, 1) : alloc.toolGroupCap} // 审阅 P1-3：展开态每组可占 expandCap+2 行，总高失控——收 1 组全文余折叠（全文走 /output）；B1 单展开同口径
          />
        ))}
      {active.confirm ? (
        // 审阅 P1-2：key=requestId——连续审批卡（resolved→下一张 requested 落同一渲染批）时
        // 同位置同类型组件不卸载会跨卡继承 selected/expanded/reasonMode（上一张选过 y → 新卡
        // Enter=静默批准，复活批2b④废除的行为）。key 换卡即重挂载，状态归零
        <ConfirmPrompt
          key={active.confirm.use.id}
          state={active.confirm}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onDraftKey={onDraftKey}
          draft={draft}
          readDraft={readDraft}
          onInterruptTurn={onInterruptTurn}
        />
      ) : (
        active.streamingText !== '' &&
        (alloc.degraded ? (
          <Text dimColor>{TOO_SMALL_HINT}</Text>
        ) : active.streaming ? (
          <GrayStreaming text={active.streamingText} maxLines={alloc.streamMaxLines} />
        ) : (
          <CappedAssistantMessage text={active.streamingText} maxLines={alloc.streamMaxLines} />
        ))
      )}
      {children}
    </Box>
  )
}

/** M14-V5：轮末残留 markdown（error 轮无 completed 帧）超预算时不渲染全文（markdown 截断
 *  会破碎语法）——降级提示行，全文在 transcript（/output 可看） */
function CappedAssistantMessage({ text, maxLines }: { text: string; maxLines: number }): ReactElement {
  const { columns } = useViewport()
  const { total } = foldStreamText(text, undefined, columns)
  if (total > maxLines * 2) {
    return (
      // 审阅 P1-8：/output 列表不含 assistant 文本——改指历史区（下次提交后兜底 commit 进 Static 可滚回看）
      <Text dimColor>⋯ 本轮回复共 {total} 行，终端预算内不展示（再次输入后进入历史区可回看全文）</Text>
    )
  }
  return <AssistantMessage text={text} />
}
