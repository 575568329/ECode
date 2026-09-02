/**
 * 对话流（最小 Static 方案 + M3 ConfirmPrompt，详设 §7）。
 *
 * 两区模型：Static（历史固化）+ 动态区（当前轮 ①②③ + confirm 弹窗）。
 * confirm 期间（active.confirm 非空）ConfirmPrompt 替代 ③ 流式位（此时流式已停）。
 */
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, Static } from 'ink'
import { ToolGroupView } from './ToolGroupView.js'
import { ToolLine } from './ToolLine.js'
import { TimelineView } from './TimelineView.js'
import { ConfirmPrompt } from './ConfirmPrompt.js'
import { foldStreamText } from './stream.js'
import { allocateDynamic, useViewport, clipWidth } from './viewport.js'
import { MessageRow } from './MessageRow.js'
import { symbols } from './symbols.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import type { CommittedItem, ActiveState, ActiveTool, CommittedToolCall } from './types.js'

/** 用户输入折叠上限（P1-A：防粘贴长代码撑爆动态区）。
 *  提交即锁死（2026-09-01）：成功路径 userInput 已清空、全文 echo 进 Static（TuiApp doSubmit），
 *  此折叠只剩发送失败回执窗口在用（消息不进 transcript，不能乐观 echo，见 doSubmit 注释） */
const USER_INPUT_MAX_LINES = 2

/** M14-V5 退化保护提示（budget < 12：宁可不显示也不触发 Ink 全清兜底） */
const TOO_SMALL_HINT = '[终端过小，本轮内容已折叠——Ctrl+T 查看]'

// GrayStreaming 已迁 TimelineView.tsx（活动流 B4——解 Conversation↔TimelineView 循环引用）；
// 此处 re-export 保持 AssistantMessage 等旧 import 路径零改动。
export { GrayStreaming } from './TimelineView.js'

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
    case 'tool-group': {
      // G1：单工具组省略组头（「1 个工具」冗余——动静切换无跳变：动态区本就无组头）；
      // 多工具连续合并组保留组头（并行批语义）
      const tools = callsToTools(item.calls)
      if (tools.length === 1) return <ToolLine tool={tools[0]!} mode="static" />
      return <ToolGroupView tools={tools} />
    }
    case 'compacted':
      // M5 压缩点标记：UI 显示全量原文（投影分离），此处告知模型上下文已被摘要
      // F-36：空 2 列槽对齐正文栅格（CC BriefTool 空 minWidth=2 同款，不加视觉噪声）
      return (
        <MessageRow icon="" dim>
          <Text dimColor>
            ⇕ 已压缩（上方 {item.removedCount} 条已摘要进上下文，原文仍显示）
          </Text>
        </MessageRow>
      )
    case 'rewind':
      // M9-P2 回退点标记：下方消息不再进模型上下文（投影截断），原文仍显示
      return (
        <MessageRow icon="" dim>
          <Text dimColor>
            ⇺ 已回退至快照点 {item.seq}（此处之后的对话不再进入上下文，原文仍显示）
          </Text>
        </MessageRow>
      )
    case 'thinking':
      // 活动流 D4-B：思考折叠行（正文在 Ctrl+T 面板）——转写面入栅格，✻ 占图标槽
      return (
        <MessageRow icon={symbols.thinking} dim>
          <Text dimColor>思考 · 持续了 {Math.max(1, Math.round(item.durMs / 1000))} 秒</Text>
        </MessageRow>
      )
  }
}

interface ConversationProps {
  committed: CommittedItem[]
  active: ActiveState
  onConfirm?: () => void
  onCancel?: () => void
  /** 批2b ①：审批卡字符转发主输入框；②：草稿镜像（非空时单字母快捷失效） */
  onDraftKey?: (input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean }) => void
  draft?: string
  /** 批2b-fix：按键时刻直读主输入框权威值（透传 ConfirmPrompt） */
  readDraft?: () => string
  /** F-31：卡上 Ctrl+C=拒卡+中断整轮（透传 ConfirmPrompt） */
  onInterruptTurn?: () => void
  /** 插话排队留痕（2026-08-29 用户点名）：queue/snapshot 驱动，动态区渲染排队用户行 */
  queuedInterjects?: string[]
  children?: ReactNode
  /** 审阅 P1-1：条件段活跃态（TasksBar/SubagentBar 各 ≤3 行——allocateDynamic 显式扣减）；
   *  审阅 P0-2：todoLines=常驻 todo 面板实占行数（TuiApp 派生，同入扣减） */
  conditions?: { tasksBar?: boolean; subagentBar?: boolean; todoLines?: number }
  /** F-48 批 1：alt-screen 全屏内容——非 null 时动态区/children 整体替换为它（Static
   *  骨架保持挂载：游标不归零即不会历史重放；数据由调用方冻结/补齐）。children 含
   *  ActivityBar/InputStream 骨架等，alt 下全部让位 */
  altContent?: ReactNode
}

export function Conversation({
  committed,
  active,
  onConfirm,
  onCancel,
  onDraftKey,
  draft,
  readDraft,
  onInterruptTurn,
  queuedInterjects = [],
  children,
  conditions,
  altContent,
}: ConversationProps): ReactElement {
  // M14-V5（§3.4）总守卫：动态区顶层一次分配；活动流 B4——timeline 总预算字段
  const { budget } = useViewport()
  const alloc = allocateDynamic(budget, conditions)
  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item: CommittedItem) => (
          <Box key={item.id}>{renderCommitted(item)}</Box>
        )}
      </Static>
      {/* F-48：alt-screen 模式——动态区整体替换为全屏面板（Static 骨架保持挂载：游标
          不归零即不会历史重放；children/InputStream 亦常驻由调用方折叠——草稿不丢）。
          普通模式动态区照旧：当前轮 ①②③ + confirm */}
      {altContent !== undefined ? (
        altContent
      ) : (
        <>
      {/* 动态区：用户输入 + 时间线 + confirm（活动流 B4——①②③ 固定槽位退役） */}
      {active.userInput !== '' && <FoldedUserInput text={active.userInput} />}
      {alloc.degraded ? (
        // F-51 智能分级平移：极小终端不渲染输出体，折叠提示行（条目名在 loading 行 digest 承担）
        <MessageRow icon="" dim>
          <Text dimColor>{TOO_SMALL_HINT}</Text>
        </MessageRow>
      ) : (
        active.timeline.length > 0 && (
          // R2/P1-1（设计 §5.5.1 S2 审批压缩）：confirm 打开时 timeline 压成 1 行让位
          // ConfirmPrompt（其自管公式只看 budget 不知道头顶 timeline 占行——并存必超）
          <TimelineView
            timeline={active.timeline}
            lines={active.confirm !== null ? 2 : alloc.timelineLines}
            liveMaxLines={alloc.streamMaxLines}
          />
        )
      )}
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
      ) : null}
      {/* 插话排队留痕（2026-08-29 用户点名）：轮内即时可见；注入后文本随轮末 commit 以
          user 消息落转写（F-35 包装原文），此处排队行随即被 queue/snapshot 摘除——不重不漏 */}
      {queuedInterjects.map((q, i) => (
        <MessageRow key={`qi-${i}`} icon={symbols.prompt} dim>
          <Text dimColor>
            {/* R3/§1.5：显示宽度截断（旧 q.slice(0,46) 是字符数——46 个 CJK=92 列破预算） */}
            {clipWidth(q, 46)}
            （已排队 · Ctrl+U 清空）
          </Text>
        </MessageRow>
      ))}
        </>
      )}
      {children}
    </Box>
  )
}
