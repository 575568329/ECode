import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ConfirmState } from './types.js'
import { theme } from './theme.js'
import { DiffLine } from './DiffLine.js'
import { insert, backspace, moveLeft, moveRight, type CursorState } from './cursor.js'
import { createCursor } from './cursor.js'
import { isSensitivePath } from '../tools/sensitive.js'
import * as nodePath from 'node:path'
import { ROWS_FALLBACK, computeBudget, sectionBudget, useViewport } from './viewport.js'

/**
 * 确认弹窗（详设 §7.3 + 批2b §10.5 五条拍板）：副作用工具执行前给用户决策。
 *
 * 批2b 交互新约（opencode 实证方案，拍板-2 a 五条全做）：
 * 1. **卡激活时字符不吞**——打字可见地进输入框（本组件只消费 y/n/a 单字母快捷，
 *    其余字符经 onDraftInsert 转发主输入框；应答后草稿还在可继续编辑/插话）；
 * 2. **有草稿时单字母快捷失效**（打「yes」首字母不误触发——草稿非空时 y/n/a 走输入框）；
 * 3. **Esc=拒绝**（直觉出口；与 Ctrl+C 同语义）；
 * 4. **Enter 误批防护**——未显式选择（←→ 或单字母）时 Enter 不确认；默认 selected=null
 *    （旧版默认选中 y、CR=静默批准是双害，批2b 拍板废除）；
 * 5. **拒绝带理由**——拒绝前可按 r 进理由输入模式（RejectPrompt 式一行文本），
 *    Enter 提交拒绝，理由经 approval/respond message 随 tool_result is_error 回传（治 F-15）。
 *
 * 展示：edit_file=unified diff / write_file=content / bash=命令；F-10 长内容「看全文」：
 * 按 v 在截断/完整 preview 间切换（完整态用更大的行数预算，防超屏由 viewport 封顶）。
 * F-13：bash 命令命中敏感路径（isSensitivePath）时黄字 advisory 提示（不做硬门）。
 *
 * 高度感知截断：动态区 outputHeight ≥ 视口行数会触发 Ink fullscreen——preview 行数必须
 * 按终端行数封顶。非 TTY（测试 pipe）rows 未知 → 兜底 24。
 */

/** 预留（相对 budget=rows−2）= 弹窗骨架 7 + 弹窗时动态区共存 9 + 余量 1（审阅实测推导） */
const PREVIEW_RESERVE = 15
/** 极矮终端保命线：preview 至少留 5 行 */
const PREVIEW_MIN_LINES = 5
/** F-10 展开态预留（审阅 P0-1 修复）：只放宽骨架+共存（≈9），经 sectionBudget 封顶——
 * 24 行终端展开态 ≈13 行。语义=「多看几行」而非「全屏铺开」（旧 (rows−2)×3 公式
 * rows=24 时 66 行+骨架 ≈8 行必超屏，触发 Ink fullscreen 清 scrollback） */
const EXPAND_RESERVE = 9

export function previewMaxLines(rows: number | undefined, expanded = false): number {
  const budget = computeBudget(rows ?? ROWS_FALLBACK)
  const base = Math.max(PREVIEW_MIN_LINES, sectionBudget(budget, PREVIEW_RESERVE))
  if (!expanded) return base
  return Math.max(base, sectionBudget(budget, EXPAND_RESERVE))
}

/** 超高 preview 保头尾截断：头 2/3 + 省略计数 + 尾 1/3 */
export function clampPreviewLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines
  const head = Math.max(2, Math.ceil(((max - 1) * 2) / 3))
  const tail = max - 1 - head
  const omitted = lines.length - head - tail
  return [
    ...lines.slice(0, head),
    `⋯ 省略 ${omitted} 行（共 ${lines.length} 行）`,
    ...lines.slice(lines.length - tail),
  ]
}

/** 是否值得给「看全文」入口：preview 被截过（行数超过默认预算）才显示 v 提示（F-10） */
export function isPreviewClamped(preview: string, rows: number | undefined): boolean {
  return preview.split('\n').length > previewMaxLines(rows)
}

export type ConfirmChoice = 'y' | 'n' | 'a'

/** 审批卡按键语义（批2b 五条的键盘路由核心，纯函数便于 ink-testing 外单测）：
 * - draft：主输入框草稿是否非空（非空时 y/n/a 单字母失效——走输入框通道）
 * - selected：null=未显式选择（Enter 不确认，防误批）；←→/单字母后变为 y/n/a
 * - reasonMode：拒绝理由输入模式（Enter=提交拒绝+理由，Esc=退出理由模式不拒绝）
 * - 返回 action：'select'（更新选中）/ 'confirm'（应答 ok/always/message）/ 'draft'（字符进草稿）
 *   / 'reason-edit'（理由编辑）/ 'toggle-expand'（F-10）/ 'none' */
export type ConfirmKeyAction =
  | { action: 'none' }
  | { action: 'select'; choice: ConfirmChoice }
  | { action: 'confirm'; ok: boolean; always?: boolean; reason?: string }
  | { action: 'draft' }
  | { action: 'reason-edit'; next: CursorState }
  | { action: 'reason-enter' }
  | { action: 'reason-cancel' }
  | { action: 'toggle-expand' }

export interface ConfirmKeyCtx {
  hasDraft: boolean
  selected: ConfirmChoice | null
  reasonMode: boolean
  reason: CursorState
  canAlways: boolean
  canExpand: boolean
  expanded: boolean
}

export function confirmKeyAction(input: string, key: {
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  home?: boolean
  end?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
}, ctx: ConfirmKeyCtx): ConfirmKeyAction {
  const { hasDraft, selected, reasonMode, reason, canAlways } = ctx
  // —— 理由输入模式（拒绝带理由 ⑤）：编辑键归理由行，Enter 提交、Esc 退出（不拒绝）——
  if (reasonMode) {
    if (key.return) return { action: 'reason-enter' }
    if (key.escape) return { action: 'reason-cancel' }
    if (key.leftArrow) return { action: 'reason-edit', next: moveLeft(reason) }
    if (key.rightArrow) return { action: 'reason-edit', next: moveRight(reason) }
    if (key.backspace) return { action: 'reason-edit', next: backspace(reason) }
    if (!key.ctrl && !key.meta && input !== '') {
      return { action: 'reason-edit', next: insert(reason, input.replace(/\r\n?/g, '\n')) }
    }
    return { action: 'none' }
  }
  // —— 单字母快捷：草稿非空时失效（② 打 yes 不误触发）——
  const letterHotkeys = !hasDraft && !key.ctrl && !key.meta
  // 单字母 y/n/a = 显式选择并立即确认（老习惯）；r = 进理由模式（不直接拒绝）
  if (letterHotkeys && input === 'y') return { action: 'confirm', ok: true }
  if (letterHotkeys && input === 'n') return { action: 'confirm', ok: false }
  if (letterHotkeys && input === 'a' && canAlways) return { action: 'confirm', ok: true, always: true }
  if (letterHotkeys && input === 'r') {
    // r 进拒绝理由模式（不直接拒绝；Enter 在理由模式里提交）——r 常用于草稿单词，有草稿时同样失效
    return { action: 'reason-edit', next: reason }
  }
  if (key.leftArrow || key.rightArrow) {
    // 三选项循环（y → n → a → y）；未选择时 ←→ 给出默认起点
    const order: ConfirmChoice[] = canAlways ? ['y', 'n', 'a'] : ['y', 'n']
    const cur = selected === null ? order.length - 1 : order.indexOf(selected)
    const dir = key.leftArrow ? -1 : 1
    return { action: 'select', choice: order[(cur + dir + order.length) % order.length] }
  }
  if (key.return) {
    // ④ Enter 误批防护：未显式选择（null）不确认——需先 ←→/单字母显式选择
    if (selected === null) return { action: 'draft' } // Enter 留给输入框提交（草稿通道）
    if (selected === 'a') return { action: 'confirm', ok: true, always: true }
    return { action: 'confirm', ok: selected === 'y' }
  }
  if (key.escape || (key.ctrl && input === 'c')) {
    // ③ Esc=拒绝（直觉出口；与 Ctrl+C 同语义）
    return { action: 'confirm', ok: false }
  }
  // F-10：v 切换看全文（草稿非空时同样让位——v 是常见单词字母）
  if (letterHotkeys && input === 'v' && ctx.canExpand) return { action: 'toggle-expand' }
  // ① 其余字符进草稿（可见地进输入框，不吞）
  if (!key.ctrl && !key.meta && !key.tab && input !== '') return { action: 'draft' }
  if (key.backspace || key.delete || key.home || key.end) return { action: 'draft' }
  return { action: 'none' }
}

interface ConfirmPromptProps {
  state: ConfirmState
  /** 清 active.confirm（父卸载本组件） */
  onConfirm?: () => void
  onCancel?: () => void
  /** 批2b ①：按键转发主输入框（字符/退格/Enter 提交草稿——TextInput 在审批期 inactive，
   * 编辑与提交语义由 TuiApp 经 insert 通道兑现；ConfirmPrompt 独立渲染（测试）时缺省丢弃） */
  onDraftKey?: (input: string, key: { return?: boolean; backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean }) => void
  /** 批2b ①/②：主输入框草稿只读镜像（渲染提示用；hasDraft 判定优先走 readDraft 事件时直读） */
  draft?: string
  /** 批2b-fix：按键时刻直读主输入框权威值（draftPort）——渲染镜像在重负载下可能滞后
   * （提交清框的 onDraftChange 传播慢于卡出现），事件时直读根除 hasDraft 陈旧 */
  readDraft?: () => string
}

export function ConfirmPrompt({ state, onConfirm, onCancel, onDraftKey, draft = '', readDraft }: ConfirmPromptProps): ReactElement {
  const input = state.use.input as Record<string, unknown>
  const target = String(input.path ?? input.command ?? '')
  const isDiff = state.use.name === 'edit_file'
  const rememberText = state.rememberLabel ?? (state.use.name.startsWith('mcp__') ? '本会话记住' : undefined)
  const isMcp = rememberText !== undefined
  // 批2b ④：默认未选择（null）——Enter 不再静默批准；必须显式 ←→/单字母
  const [selected, setSelected] = useState<ConfirmChoice | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [reasonMode, setReasonMode] = useState(false)
  const [reason, setReason] = useState<CursorState>(() => createCursor(''))
  const { rows } = useViewport()
  const allLines = state.preview.split('\n')
  const maxLines = previewMaxLines(rows, expanded)
  const canExpand = allLines.length > previewMaxLines(rows, false)
  const previewLines = expanded ? clampPreviewLines(allLines, maxLines) : clampPreviewLines(allLines, previewMaxLines(rows, false))

  // F-13：bash 审批敏感命令 advisory（isSensitivePath 现成判定——命令文本里出现的绝对/带~路径
  // 逐段检验；黄字提示不做硬门）。敏感读已有 sensitiveGate 硬门，此处只覆盖「写/bash 泄密面」提示。
  // 审阅 P1-4：useMemo——tokenize+isSensitivePath 内部 realpathSync 是同步 IO，不能进渲染
  // 热路径（draft 每字符变化/每个按键都重渲染）；只在 command 本身变化时算一次。
  const commandText = String(input.command ?? '')
  const sensitiveHit = useMemo(
    () => (state.use.name === 'bash' ? detectSensitiveCommand(commandText) : false),
    [state.use.name, commandText],
  )

  const decide = (ok: boolean, always = false, reasonText?: string) => {
    state.resolve(ok, always, reasonText)
    if (ok) onConfirm?.()
    else onCancel?.()
  }

  useInput((inputChar, key) => {
    const act = confirmKeyAction(inputChar, key, {
      hasDraft: (readDraft ? readDraft() : draft) !== '',
      selected,
      reasonMode,
      reason,
      canAlways: isMcp,
      canExpand,
      expanded,
    })
    switch (act.action) {
      case 'select':
        setSelected(act.choice)
        break
      case 'confirm':
        decide(act.ok, act.always === true, act.reason)
        break
      case 'draft':
        // ① 字符不吞：转发主输入框（含 Enter——未选择/草稿非空时提交草稿走插话通道）
        onDraftKey?.(inputChar, key)
        break
      case 'reason-edit':
        setReasonMode(true)
        setReason(act.next)
        break
      case 'reason-enter':
        decide(false, false, reason.text.trim() === '' ? undefined : reason.text.trim())
        break
      case 'reason-cancel':
        setReasonMode(false)
        break
      case 'toggle-expand':
        setExpanded((e) => !e)
        break
      default:
        break
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Box>
        <Text color={theme.warn} bold>
          ⚠ 执行 {state.use.name}?
        </Text>
        {target !== '' && <Text> {target}</Text>}
      </Box>
      {sensitiveHit && (
        <Box>
          <Text color="yellow">⚠ 命令涉及敏感路径（{sensitiveHit}）——确认这不是在读取/外传密钥</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {isDiff
          ? previewLines.map((line, i) => (
              <Box key={i}>
                <DiffLine line={line} />
              </Box>
            ))
          : <Text dimColor>{previewLines.join('\n')}</Text>}
        {canExpand && (
          <Text dimColor> v {expanded ? '收起' : '看全文'}（共 {allLines.length} 行）</Text>
        )}
      </Box>
      {reasonMode ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>拒绝理由： </Text>
          <Text>
            <Text>{reason.text}</Text>
            <Text inverse> </Text>
          </Text>
          <Text dimColor>   回车=带理由拒绝 · Esc=返回</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text inverse={selected === 'y'} bold={selected === 'y'}>
            {' [y] 执行 '}
          </Text>
          <Text>   </Text>
          <Text inverse={selected === 'n'} bold={selected === 'n'}>
            {' [n] 取消 '}
          </Text>
          {isMcp && (
            <>
              <Text>   </Text>
              <Text inverse={selected === 'a'} bold={selected === 'a'} color="green">
                {` [a] ${rememberText} `}
              </Text>
            </>
          )}
          <Text dimColor>
            {'   ← →/y/n 选择 · 回车确认 · Esc/r+理由=拒绝'}
            {isMcp ? ` · a=${rememberText}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** F-13：bash 命令里的敏感路径探测（词法提取路径段 → isSensitivePath 判定；返回命中段用于提示） */
export function detectSensitiveCommand(command: string): string | null {
  if (command === '') return null
  // 提取候选路径段：空白分隔 token + 常见路径形态（/…、~…、盘符…、./…）。
  // 清洗（审阅 P1-3）：剥头尾引号（`cat "C:\Users\x/.ssh/id_rsa"` 曾漏报）+ 剥 `VAR=`
  // 环境变量前缀（`FOO=~/.ssh/id_rsa` 同漏报）；截尾逗号等
  const tokens = command.match(/[^\s|;&<>]+/g) ?? []
  for (const raw of tokens) {
    const t = raw.replace(/^["']*/, '').replace(/["',]+$/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '')
    if (!(t.startsWith('/') || t.startsWith('~') || t.startsWith('./') || t.startsWith('../') || /^[a-zA-Z]:[\\/]/.test(t))) continue
    const abs = t.startsWith('~') ? t.replace(/^~/, getUserHome()) : t
    try {
      if (isSensitivePath(resolveMaybe(abs))) return t
    } catch {
      // 判定异常不阻塞审批（advisory 只做提示）
    }
  }
  return null
}

function getUserHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.'
}

function resolveMaybe(p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.resolve(process.cwd(), p)
}
