import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput, Text, Box } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { runLoop, type ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import { isMessageLine, type AppError, type ContentBlock, type HistoryLine, type ImageBlock, type Message, type RewindLine } from '../core/types.js'
import { makeOnBeforeRequest } from '../services/compaction/hook.js'
import { tokensToCost } from '../services/pricing.js'
import { buildContextMessages } from '../core/context.js'
import { estimateContextTokens } from '../services/tokenizer.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { createActive, type CommittedItem, type ActiveState } from './types.js'
import { messagesToCommitted, findUse } from './commit.js'
import { buildSystemPrompt } from '../core/system.js'
import { expandSkill, type SkillRegistry } from '../services/skill.js'
import { registerSkillHooks, unregisterAllSkillHooks } from '../services/hooks/global.js'
import type { HookRunner } from '../services/hooks/runner.js'
import {
  callLLM,
  DRAFT_SYSTEM,
  MERGER_SYSTEM,
  buildDraftUser,
  buildMergerUser,
  serializeSession,
  parseCandidate,
  parseMergerVerdicts,
  conflictTitles,
  decisionsFromVerdicts,
  patchBodyFromVerdicts,
  renderCreatePreview,
  renderUpgradePreview,
} from '../services/skill/distill.js'
import { buildPreview } from '../services/preview.js'
import { buildProviderReq, loadConfig, writeWizardConfig, type Config } from '../services/config.js'
import { ModelPicker, type ModelEntry } from './ModelPicker.js'
import { HistoryPicker } from './HistoryPicker.js'
import { Wizard } from './Wizard.js'
import { SkillPanel } from './SkillPanel.js'
import { McpPanel } from './McpPanel.js'
import { PluginPanel } from './PluginPanel.js'
import { QuestionPanel } from './QuestionPanel.js'
import { WarningsPanel } from './WarningsPanel.js'
import { RewindPanel } from './RewindPanel.js'
import { SandboxPanel } from './SandboxPanel.js'
import { ConfigPanel, type ConfigItem } from './ConfigPanel.js'
import { saveConfigKey } from '../services/configFs.js'
import { makeSandbox, nextSandboxMode, type SandboxMode } from '../services/sandbox.js'
import { setPermissionAsker } from '../services/permissions.js'
import { setSubagentBridge, setSubagentProgressHandler, type SubagentStatus } from '../services/subagent.js'
import { SubagentBar } from './SubagentBar.js'
import { ecodeCommit, undoEcodeCommit } from '../services/git.js'
import { readClipboardImage } from '../services/clipboard.js'
import { buildMediaBlock } from '../services/media.js'
import { taskRegistry } from '../services/tasks.js'
import { pushNotice, deriveNoticeLine, renderNoticeLine, type NoticeItem, type NoticeLevel } from './notices.js'
import { setAskUserHandler } from '../tools/builtin/askUserBridge.js'
import type { AskUserQuestion, AskUserResult } from '../tools/builtin/ask_user.js'
import { Select } from './Select.js'
import type { McpManager, McpServerSnapshot } from '../services/mcp/manager.js'
import type { SessionMeta } from '../services/history.js'

/** 清屏（可见区 + scrollback + 光标归位）；/clear 用，清可见区残留 */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H'

export interface TuiAppDeps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
  orchestrator: CompactionOrchestrator
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number }
  /** M6：skill 注册表（清单注入 + 手动触发展开） */
  skillRegistry: SkillRegistry
  /** M6：MCP 管理器（null = 未初始化，如 argv 单次模式简化路径） */
  mcpManager: McpManager | null
  /** M6：项目级 .mcp.json 待批准（启动检测，TuiApp 弹批准 overlay） */
  mcpPendingApproval?: { file: string; approve: () => Promise<void> }
  /** M6：MCP 启动警告（解析失败/env 缺失跳过/项目级覆盖——不透传用户无感知，审阅 P1） */
  mcpWarnings?: string[]
  /** M8：指令/记忆截断提示（注入内容用户不可见，截断需可行动） */
  instructionWarnings?: string[]
  /** M7：hooks 分发器（null = 未启用；SessionStart/UserPromptSubmit/Stop 在此触发） */
  hookRunner?: HookRunner | null
  /** M9-P1：快照存储（null/undefined = 未启用，如测试；onBeforeWrite 装配进 toolCtx） */
  checkpoint?: import('../services/checkpoint.js').CheckpointStore | null
  /** M9-P3：编辑后 lint/test 回喂门（null = 未启用；afterTools 装配进 runLoop opts） */
  quality?: import('../services/quality.js').QualityGate | null
  /** M7：plugin 装载器（null = 未启用；/plugin 面板操作） */
  pluginLoader?: import('../services/plugin/loader.js').PluginLoader | null
  /** /restart 的执行句柄（cli 注入：unmount + spawn 新实例 + exit；缺省时提示不可用） */
  onRestart?: () => void
}

/** M10-P3：afterTools 工厂（quality 回喂 + autoCommit 轮末 + 后台任务 turn 内通知）。 */
function makeAfterTools(
  deps: TuiAppDeps,
  config: import('../services/config.js').Config,
  pushNoticeFn: (level: 'error' | 'warn' | 'info', text: string) => void,
  editedFilesRef: { current: Set<string> },
  messagesRef: { current: HistoryLine[] },
): NonNullable<import('../core/loop.js').LoopRunOptions['afterTools']> {
  return async (round) => {
    let feedback: string | undefined
    if (deps.quality) {
      const fb = await deps.quality.afterRound(round.tools)
      if (fb !== undefined) {
        pushNoticeFn('warn', 'lint/test 有失败，已回喂模型自纠')
        feedback = fb
      }
    }
    // M10-P3：后台任务 turn 内通知（独立于 quality feedback——终审 P1-5：通知并入 feedback 会
    // 抑制 autoCommit 并清空文件集，模型编辑恰逢任务完成时提交永久丢失；autoCommit 只看 quality 结果）
    const notes = taskRegistry.collectNotifications()
    const qualityBlocked = feedback !== undefined || deps.quality?.lastRoundFailed === true || deps.quality?.tripped === true
    if (config.autoCommit === true && !qualityBlocked) {
      const files = [...editedFilesRef.current]
      editedFilesRef.current.clear()
      if (files.length > 0) {
        const lastAsst = [...messagesRef.current].reverse().find((l): l is Message => isMessageLine(l) && l.role === 'assistant')
        const textBlock = lastAsst?.content.find((b) => b.type === 'text')
        const subject =
          textBlock !== undefined && 'text' in textBlock && textBlock.text.trim() !== ''
            ? `ecode: ${textBlock.text.trim().split('\n')[0]?.slice(0, 60)}`
            : `ecode: 修改 ${files.length} 个文件`
        const r = await ecodeCommit(process.cwd(), deps.history.currentSessionId(), files, subject)
        pushNoticeFn(r.committed ? 'info' : 'warn', r.committed ? `已自动提交：${subject}` : `自动提交未完成——${r.reason ?? ''}`)
      }
    } else {
      editedFilesRef.current.clear()
    }
    const combined =
      feedback !== undefined
        ? notes.length > 0
          ? `${feedback}\n${notes.join('\n')}`
          : feedback
        : notes.length > 0
          ? notes.join('\n')
          : undefined
    return combined !== undefined ? { feedback: combined } : undefined
  }
}

/** M10-P2：常规页可编辑项（从 config 派生；值展示 + 档位循环） */
function generalConfigItems(config: import('../services/config.js').Config): ConfigItem[] {
  return [
    { key: 'maxIterations', label: 'maxIterations（每轮最大迭代）', value: String(config.maxIterations), options: ['20', '50', '100', '200'], kind: 'enum' },
    { key: 'autoCommit', label: 'autoCommit（编辑轮末自动 git 提交）', value: String(config.autoCommit === true), options: ['false', 'true'], kind: 'toggle' },
    { key: 'webSearch.provider', label: 'webSearch.provider（搜索引擎）', value: config.webSearch?.provider ?? 'bing', options: ['bing', 'zhipu'], kind: 'enum' },
    { key: 'lintCommand', label: 'lintCommand（空=自动探测）', value: config.lintCommand ?? '', kind: 'readonly' },
  ]
}

/** M10-P2b：磁盘图片路径 → ImageBlock[]（守卫失败降级文本提示，不阻断提交） */
async function imageBlocksFromPaths(paths: string[]): Promise<{ blocks: ImageBlock[] }> {
  const blocks: ImageBlock[] = []
  for (const p of paths) {
    try {
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(p)
      const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
      const guard = buildMediaBlock(buf, ext, p)
      if (guard.ok && guard.block.type === 'image') {
        blocks.push({ ...guard.block, _path: p })
      }
    } catch {
      // 读取失败跳过（粘贴文件被删等）
    }
  }
  return { blocks }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || 'aborted' in e)
}

/**
 * TuiApp：连接 AgentLoop 与 TUI（最小 Static 方案）。
 *
 * - committed：已固化的历史（进 <Static>，滚轮友好）
 * - active：当前轮活跃状态（分区累积：userInput / tools / streamingText）
 * - 一轮一 commit：runLoop 结束 → messagesToCommitted → setCommitted；active 清空
 */
export function TuiApp({ deps, banner: initialBanner, onRestart, onExit }: { deps: TuiAppDeps; banner?: string; onRestart?: () => void; onExit?: () => void }): ReactElement {
  const messagesRef = useRef<HistoryLine[]>([])
  const abortRef = useRef<AbortController>(new AbortController())
  const runningRef = useRef(false)
  // 同步 confirm 状态给 useInterrupt isActive（避免 stale closure；P0#1）
  const confirmRef = useRef(false)
  // M11-P7：插话队列（ref 为消费源，state 只驱动显示；忙碌态 Enter 入队、步间/轮末投递）
  const interjectQueueRef = useRef<string[]>([])
  const [interjectPreview, setInterjectPreview] = useState<string | null>(null)
  const enqueueInterject = async (text: string): Promise<void> => {
    // 斜杠拦截不在此（审阅 P0-1：InputStream 分流点已拦，这里收到的一定是普通文本；
    // 曾在此挂 / 前缀守卫——不可达且会误杀以 / 开头的合法插话文本如粘贴路径，已删）
    // F2：入队时过 UserPromptSubmit hook（loop 内 append 会绕过 submit 内的分发——M9-P0 接线口子）
    let finalText = text
    if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {
      const verdict = await deps.hookRunner.dispatch('UserPromptSubmit', { event: 'UserPromptSubmit', session_id: '', prompt: text })
      if (verdict.block) {
        setSystemMsgs([`✋ 插话被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}`])
        return
      }
      if (verdict.additionalContext.length > 0) finalText = `${finalText}\n\n[hook context]\n${verdict.additionalContext.join('\n')}`
    }
    interjectQueueRef.current.push(finalText)
    setInterjectPreview(interjectQueueRef.current[0] ?? null)
  }
  // M11-P4：运行中子代理快照（进度桥推送）
  const [subagents, setSubagents] = useState<SubagentStatus[]>([])
  // M11 §1.3：confirm 串行队列（ActiveState.confirm 覆盖式单槽——并发子代理 confirm 后到覆盖前者，
  // resolve 闭包丢失 → Promise 永挂 → 父死锁；父/子 confirm 全走此队列，单请求时深度 1 行为不变）
  const confirmQueueRef = useRef(Promise.resolve())
  const queueConfirm = (fn: (use: import('../core/types.js').ToolUseBlock) => Promise<boolean>) => {
    return (use: import('../core/types.js').ToolUseBlock) => {
      const run = confirmQueueRef.current.then(
        () => fn(use),
        () => fn(use),
      )
      confirmQueueRef.current = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }
  }
  /** M9-P4 确认弹窗逻辑（组件级——submit 与子代理桥共用，经 queueConfirm 串行） */
  const doConfirm = async (use: import('../core/types.js').ToolUseBlock): Promise<boolean> => {
    // full-access 全免确认（deny 语义仍硬拒在工具层：内置黑名单 + blockedCommands）
    if (sandboxModeRef.current === 'full-access') return true
    // read-only 档——MCP 副作用工具整体拒绝（本地 write/edit/bash 在工具层拦，文案准确；
    // MCP 经 server 无法工具层拦，此处 false + 用户提示，LLM 收到 is_error 自纠）
    if (sandboxModeRef.current === 'read-only' && use.name.startsWith('mcp__')) {
      setSystemMsgs([`read-only 模式：MCP 工具 ${use.name} 被拒绝`])
      return false
    }
    // MCP「本会话记住」（M6 v3 P1-3）：server 级前缀放行（mcp__server__*），本会话不再逐次弹窗
    const mcpPrefix = use.name.startsWith('mcp__') ? use.name.split('__').slice(0, 2).join('__') : null
    if (mcpPrefix !== null && confirmAlwaysRef.current.has(mcpPrefix)) return true
    // D5：callback 内部算预览（不污染 Tool 接口）；P1#3：catch 异常不杀 Loop
    const preview = await buildPreview(use, process.cwd()).catch(
      (e) => `⚠ 无法生成预览：${e instanceof Error ? e.message : String(e)}`,
    )
    confirmRef.current = true
    return new Promise<boolean>((resolve) => {
      setActive((a) => ({
        ...a,
        confirm: {
          use,
          preview,
          resolve: (ok, always) => {
            if (ok && always === true && mcpPrefix !== null) confirmAlwaysRef.current.add(mcpPrefix)
            resolve(ok)
          },
        },
      }))
    })
  }

  /** usage 记录（submit 与子代理桥共用——成本归并；「本轮」语义被并发稀释为最后到达者，文档化） */
  const recordUsage = (inp: number, out: number, cache?: { read?: number; creation?: number }) => {
    deps.lastUsage.input = inp
    deps.lastUsage.output = out
    deps.lastUsage.cacheRead = cache?.read ?? 0
    deps.lastUsage.cacheCreation = cache?.creation ?? 0
    setTokens((n) => n + inp + out)
    const c = tokensToCost(config.current.model, {
      input: inp,
      output: out,
      cacheRead: cache?.read ?? 0,
      cacheCreation: cache?.creation ?? 0,
    }, config.providers[config.current.name]?.pricing)
    if (c != null) setSessionCost((sc) => sc + c)
  }
  // 同步 picker 覆盖状态给 useInterrupt（同 confirm：覆盖期间 Ctrl+C 由 picker 处理，不中断 loop）
  const pickerRef = useRef(false)
  // ctxWindow 缓存（S-P4：submit 热路径同步用，启动解析一次 + 切模型刷新；默认 200k 兜底）
  const ctxWindowRef = useRef(200_000)
  // MCP 确认「本会话记住」前缀表（mcp__server；v3 P1-3，会话级不落盘）
  const confirmAlwaysRef = useRef(new Set<string>())
  // SessionStart 的 additionalContext 暂存（M9-P0）：注入启动/恢复后首轮 user 消息，一次性消费
  const pendingSessionCtxRef = useRef<string[]>([])
  // M9-P6：本轮编辑文件集（onBeforeWrite 收集；autoCommit 开启时轮末提交+清空）
  const editedFilesRef = useRef<Set<string>>(new Set())
  // M10-P2b：待发送的粘贴图片（Alt+V 落盘后的路径；submit 时按文本引用组装 blocks 并清空）。
  // 真机修复批 v2（两家同款内嵌形态）：粘贴把短标签 [图片#N] 插入输入框文本，标签即引用——
  // 删标签=删图（提交剪枝），无独立附件行（v1 的输入框上方行已退役）
  const [pendingImages, setPendingImages] = useState<Array<{ path: string; label: string }>>([])

  /** M10-P2b：Alt+V 粘贴——读剪贴板图落附件目录，返回插入输入框的短标签（无图 null） */
  const pasteImageFromClipboard = async (): Promise<string | null> => {
    const img = await readClipboardImage(deps.history.currentSessionId())
    if (img === null) {
      setSystemMsgs(['剪贴板无图片（或读取失败）'])
      return null
    }
    // 序号取自当前渲染闭包（Alt+V 是离散用户事件，闭包即最新；数组本体仍走函数式 append 保正确）
    const label = `[图片#${pendingImages.length + 1}]`
    setPendingImages((prev) => [...prev, { path: img.path, label }])
    return label
  }
  // M9-P4：沙箱模式（会话级不落盘；初始取 config.sandbox.defaultMode，default=现状=关）
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(
    deps.config.sandbox?.defaultMode ?? 'default',
  )
  const sandboxModeRef = useRef(sandboxMode)
  const applySandboxMode = (mode: SandboxMode): void => {
    sandboxModeRef.current = mode
    setSandboxMode(mode)
  }

  const [committed, setCommitted] = useState<CommittedItem[]>([])
  const [active, setActive] = useState<ActiveState>(() => createActive())
  const [activity, setActivity] = useState<{ state: ActivityState; text?: string }>({
    state: 'idle',
  })
  const [error, setError] = useState<AppError | null>(null)
  // M8 告警中心：运行时提示统一队列（onWarn/启动警告/截断提示都进这里；底部单行派生+/warnings 面板）
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const noticeIdRef = useRef(0)
  const pushNoticeFn = (level: NoticeLevel, text: string): void => {
    noticeIdRef.current += 1
    setNotices((prev) => pushNotice(prev, noticeIdRef.current, level, text))
  }
  const [tokens, setTokens] = useState(0)
  const [sessionCost, setSessionCost] = useState(0)
  const [systemMsgs, setSystemMsgs] = useState<string[]>([])
  const [iter, setIter] = useState<number | undefined>(undefined)
  const [maxIter, setMaxIter] = useState<number | undefined>(undefined)
  const [clearKey, setClearKey] = useState(0)
  // config 是 state 不是 props（§8.1.1）：/model 改 current → setConfig → 重渲染，下次 submit 用新 current
  const [config, setConfig] = useState<Config>(() => deps.config)
  // 覆盖层（/model·/history·/setup 等）：非 null 时独占输入（picker 渲染 + InputStream inactive）
  const [overlay, setOverlay] = useState<
    | { kind: 'model-picker' }
    | { kind: 'pick-history' }
    | { kind: 'setup-wizard' }
    | { kind: 'skill-panel' }
    | { kind: 'mcp-panel' }
    | { kind: 'plugin-panel' }
    | { kind: 'warnings-panel' }
    | { kind: 'rewind-panel' }
    | { kind: 'sandbox-panel' }
    | { kind: 'config-panel' }
    | { kind: 'select'; title: string; options: string[]; resolve: (v: string | undefined) => void }
    // M8 ask_user：工具发起的提问面板（Promise 桥——resolve 回工具 execute）
    | { kind: 'question-panel'; questions: AskUserQuestion[]; resolve: (r: AskUserResult) => void }
    | null
  >(null)
  // 面板回填通道（S-P6 D32：SkillPanel Enter → `/name ` 写入输入框，不直接执行）
  const [insert, setInsert] = useState<{ text: string; seq: number } | undefined>(undefined)
  // /history 打开时载入的会话列表（loadAll 只在打开时调一次，避免 render 热路径同步 IO）
  const [historyMetas, setHistoryMetas] = useState<SessionMeta[]>([])
  // banner（配置无效提示；初始从 cli 传入，/setup 成功后清，submit 配置无效时设）
  const [banner, setBanner] = useState<string | undefined>(initialBanner)
  // /plugin 面板刷新 key（安装/启停操作后重查 browse/list——数据是 loader 现查的，靠 remount 重建）
  const [pluginPanelKey, setPluginPanelKey] = useState(0)
  // /restart 句柄经 ref（deps 闭包稳定，setTimeout 回调取最新）
  const onRestartRef = useRef(onRestart)

  const submit = async (input: string, display?: string, blocks?: ContentBlock[]): Promise<void> => {
    // M10-P2b：零键位增强——提交文本恰好是存在的图片路径 → 转图片输入（display 保持原文）
    if (blocks === undefined && display === undefined && /^\s*[^\n]+\.(png|jpe?g|webp|gif)\s*$/i.test(input)) {
      const detected = await imageBlocksFromPaths([input.trim()])
      if (detected.blocks.length > 0) {
        input = `${input.trim()}（已作为图片输入）`
        blocks = detected.blocks
      }
    }
    // M10-P2b 真机修复批 v2：粘贴 pending 按文本引用组装——输入框内 [图片#N] 标签即引用，
    // 文本里没引用的（用户删了标签）不发送（两家同款剪枝语义）；引用了但读取/守卫失败的跳过并 warn。
    // 早退守卫路径（hook 拦截/配置无效/运行中）不清空暂存——消息没发出去图片不丢。
    if (blocks === undefined && pendingImages.length > 0) {
      const referenced = [...input.matchAll(/\[图片#(\d+)\]/g)].map((m) => Number(m[1]))
      const referencedPending = pendingImages.filter((_, i) => referenced.includes(i + 1))
      if (referencedPending.length > 0) {
        const built = await imageBlocksFromPaths(referencedPending.map((p) => p.path))
        const okCount = built.blocks.length
        const skipped = referencedPending.length - okCount
        if (skipped > 0) pushNoticeFn('warn', `${skipped} 张粘贴图片读取失败/超守卫被跳过（其余正常发送）`)
        if (okCount > 0) blocks = built.blocks
      }
    }
    if (runningRef.current) {
      // M11-P7：忙碌态插话——入队（含图片 [图片#N] 标签：续投走同一 submit 组装 blocks，F1）
      await enqueueInterject(input)
      return
    }
    // 配置无效态（空壳 Config）：不 runLoop，提示 /setup；/setup /history /clear 等命令不受影响
    if (!config.providers[config.current.name]) {
      setBanner('配置不完整，输入 /setup 配置')
      return
    }
    // 兑现上一轮的延迟 commit：当前轮在 runLoop 结束后保留在动态区（可 Ctrl+O 展开），
    // 直到下次 submit 才 commit 进 Static（收起固化）。符合「当前轮不固定 / 进入下一轮自动收起」。
    if (messagesRef.current.length > 0) {
      setCommitted(messagesToCommitted(messagesRef.current))
    }
    runningRef.current = true
    abortRef.current = new AbortController()
    // UserPromptSubmit hook（H-P4：分流后、runLoop 前）：block 拦截本轮输入；additionalContext 拼接进消息
    // M9-P0：controller 前置 + dispatch 透传 AbortSignal——hook 等待期 Ctrl+C 可中断 hook 子进程（此前仅超时兜底）
    if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {
      const verdict = await deps.hookRunner.dispatch(
        'UserPromptSubmit',
        {
          event: 'UserPromptSubmit',
          session_id: '',
          prompt: input,
        },
        { signal: abortRef.current.signal },
      )
      if (verdict.block) {
        runningRef.current = false
        setSystemMsgs([`✋ 输入被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}`])
        setActivity({ state: 'idle' })
        return
      }
      if (verdict.additionalContext.length > 0) {
        input = `${input}\n\n[hook context]\n${verdict.additionalContext.join('\n')}`
      }
      if (verdict.systemMessages.length > 0) setSystemMsgs(verdict.systemMessages)
    }
    // M10-P3：后台任务跨 turn 通知（双时点之二——turn 结束后完成的任务在下次 submit 前注入）
    const pendingNotes = taskRegistry.collectNotifications()
    for (const n of pendingNotes) {
      input = `${input}\n${n}`
    }
    // M9-P0：SessionStart 的 additionalContext 注入启动/恢复后首轮 user 消息（环境信息进上下文一次；
    // 在 UserPromptSubmit 之后拼接——hook 收到的 prompt 保持用户原文）
    if (pendingSessionCtxRef.current.length > 0) {
      input = `${input}\n\n[hook context]\n${pendingSessionCtxRef.current.join('\n')}`
      pendingSessionCtxRef.current = []
    }
    // 新轮：userInput 乐观显示 + streaming=true（流式灰字）。
    // display（S4.4 最小 display/content 分离）：手动 skill 触发时输入框/转录显示原始
    // `/name args`，消息本体是展开全文（runLoop 的 userInput 必须传全文，防 alreadyUser 双推）
    // M10-P2b 复审 P2-2：到此消息确认发送（所有早退守卫已过）——粘贴暂存此刻清空（附件行随之消失）
    setPendingImages([])
    setActive({ ...createActive(), userInput: display ?? input, streaming: true })
    setError(null)
    setActivity({ state: 'thinking' })
    const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
    const providerReq = buildProviderReq(config)
    const system = buildSystemPrompt(
      deps.skillRegistry.listForPrompt(),
      ctxWindowRef.current,
      config.maxInstructionsKB !== undefined ? { maxInstructionBytes: config.maxInstructionsKB * 1024 } : undefined,
    )
    const onCompacted = (m: HistoryLine[]) => {
      setCommitted(messagesToCommitted(m))
      setSystemMsgs(['✓ 已压缩对话（旧消息已摘要进上下文，原文仍显示）'])
    }
    const onCompacting = () => setSystemMsgs(['正在压缩对话...'])
    const onCompactFail = () => setSystemMsgs(['（压缩未完成——对话太短或摘要失败，稍后自动重试）'])
    const onBeforeRequest = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, {
      onCompacted,
      history: deps.history,
      signal: abortRef.current.signal,
      onCompacting,
      onCompactFail,
      tools: deps.tools.specs(), // M6：MCP 工具 schema 计入压缩估算（v3 P1-1）
    })

    let aborted = false
    try {
      await runLoop(messagesRef.current, input, {
        provider,
        tools: deps.tools,
        logger: deps.logger,
        history: deps.history,
        callbacks: {
          onText: (t) => {
            setActive((a) => ({ ...a, streamingText: a.streamingText + t }))
          },
          onToolStart: (name) => {
            // P1-2：onToolStart 只给 name（use 此时未解析）；onToolResult 后填入
            setActive((a) => ({
              ...a,
              tools: [...a.tools, { name, status: 'running' }],
            }))
            setActivity({ state: 'tool', text: name })
          },
          onToolResult: (id, name, r) => {
            // use 此刻已在 messages（finally 先于 executeTools），反查配对 active.tools
            const use = findUse(messagesRef.current, id)
            setActive((a) => {
              const tools = [...a.tools]
              // 配对：找第一个同名 running 项替换为 done
              const idx = tools.findIndex((t) => t.status === 'running' && t.name === name)
              const done = {
                name,
                use,
                result: {
                  type: 'tool_result' as const,
                  tool_use_id: id,
                  content: r.content,
                  is_error: r.is_error,
                },
                status: (r.is_error ? 'error' : 'done') as 'error' | 'done',
              }
              if (idx >= 0) tools[idx] = done
              else tools.push(done)
              return { ...a, tools }
            })
            setActivity({ state: 'thinking' })
          },
          onUsage: recordUsage,
          onIter: (i, m) => {
            setIter(i)
            setMaxIter(m)
          },
          onActivity: (state, text) => {
            // M9-P0：loop 内部消化 AbortError 正常返回（不抛出），中断信号经此回调传回——Stop 区分 aborted 用
            if (state === 'aborted') aborted = true
            setActivity({ state, text })
          },
          onWarn: (m) => pushNoticeFn('warn', m),
        },
        providerReq,
        system,
        maxIterations: config.maxIterations,
        toolCtx: {
          cwd: process.cwd(),
          signal: abortRef.current.signal,
          // M9-P1：写前快照装配（心脏零改动——loop 只透传 toolCtx；快照失败工具侧已 catch）
          onBeforeWrite: async (paths, tool, toolUseId) => {
            for (const p of paths) editedFilesRef.current.add(p) // M9-P6：autoCommit 文件集
            await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
          },
          // M9-P4：沙箱装配（read-only/workspace-write 拦截 + blockedCommands 全档硬拒在 bash 工具内）
          sandbox: makeSandbox(sandboxModeRef.current, process.cwd(), config.sandbox?.blockedCommands ?? []),
          // M10-P0：无视觉能力守卫判定用（读图前 isVisionModel）
          model: config.current.model,
        },
        // M10-P2b：附着块（图片粘贴/路径检测）进首条 user 消息
        ...(blocks !== undefined && blocks.length > 0 ? { userBlocks: blocks } : {}),
        // M9-P3 轮末质量回喂 + M9-P6 autoCommit + M10-P3 后台任务通知（工厂：见 makeAfterTools）
        afterTools: makeAfterTools(deps, config, pushNoticeFn, editedFilesRef, messagesRef),
        signal: abortRef.current.signal,
        onBeforeRequest,
        onCompacted,
        confirm: queueConfirm(doConfirm),
        // M11-P7：步间注入拉取（多条合并一条换行拼接；拉走即清显示）
        pollUserInput: () => {
          const q = interjectQueueRef.current
          if (q.length === 0) return null
          const text = q.splice(0).join('\n\n')
          setInterjectPreview(null)
          return text
        },
      })
      // 不立即 commit：本轮保留在动态区（当前轮可 Ctrl+O 展开）；streaming=false 转 Markdown 显示
      setActive((a) => ({ ...a, streaming: false }))
      setActivity({ state: 'idle' })
    } catch (e) {
      // 中断/错误：同样保留动态区（用户看中断内容），下次 submit 才 commit
      setActive((a) => ({ ...a, streaming: false }))
      if (isAbortError(e)) {
        aborted = true
        setActivity({ state: 'aborted' })
      } else {
        setError(toAppError(e))
        setActivity({ state: 'idle' })
      }
    } finally {
      runningRef.current = false
      // M11-P7：轮末兜底——settle 后队列有剩余自动续投（Ctrl+C 中断同样走此路径：停当前不停插话）
      const pending = interjectQueueRef.current.splice(0)
      if (pending.length > 0) {
        setInterjectPreview(null)
        void submit(pending.join('\n\n'))
      }
      // Stop hook（H-P4）：一轮结束即触发，fire（async hook 本就不等；systemMessage 到达后展示）
      // M9-P0：中断路径 stop_reason=aborted（hook 可区分「用户主动停」与「正常完成」）
      if (deps.hookRunner != null && deps.hookRunner.hasHandlers('Stop')) {
        void deps.hookRunner
          .dispatch('Stop', { event: 'Stop', session_id: '', stop_reason: aborted ? 'aborted' : 'turn-complete' })
          .then((v) => {
            if (v.systemMessages.length > 0) setSystemMsgs(v.systemMessages)
          })
          .catch(() => {})
      }
    }
  }

  // 清 confirm（ConfirmPrompt 内先 resolve 再调它）
  const clearConfirm = () => {
    confirmRef.current = false
    setActive((a) => ({ ...a, confirm: null }))
  }

  // 清动态/瞬态状态（onClear 和 restoreSession 共用；committed 由调用方设，§9.2 P2-6 别重写一套）
  const resetTransient = () => {
    // M7 H-P5：skill hooks 是会话级——起新会话（/clear、恢复历史）即注销全部
    unregisterAllSkillHooks()
    // 兜底：若有挂起的 confirm（inactive 本应挡住命令触发，此处 defense-in-depth），取消避免 Promise 永挂
    if (active.confirm) {
      active.confirm.resolve(false)
      confirmRef.current = false
    }
    setActive(createActive())
    setSystemMsgs([])
    setPendingImages([]) // M10 修复批：换会话不带旧会话的待发送附件
    setTokens(0)
    setSessionCost(0)
    setIter(undefined)
    setMaxIter(undefined)
    setError(null)
    // 清可见区 + scrollback（清 Static 残留）+ 光标归位
    process.stdout.write(CLEAR_TERMINAL)
    // remount App（重置 <Static> 内部 index，避免 /clear 后消息不渲染）
    setClearKey((k) => k + 1)
  }

  // /history 恢复（§9.2）：restore → 重建 committed → 清瞬态 → 起新 session 续写（D2 旧文件只读）
  /** 通用单选 overlay（S-P7 冲突裁决等异步交互；Esc/ctrl+c → resolve undefined） */
  const askSelect = (title: string, options: string[]): Promise<string | undefined> => {
    return new Promise((resolve) => {
      pickerRef.current = true
      setOverlay({ kind: 'select', title, options, resolve })
    })
  }

  // M8 ask_user UI 桥注入：工具 execute → Promise → overlay 面板 → resolve 回工具
  // （排队锁在 bridge 层——同轮多个 ask_user 串行弹，不抢 overlay）
  useEffect(() => {
    setAskUserHandler((questions) => {
      return new Promise<AskUserResult>((resolve) => {
        // 审阅 P2-2：中断当前轮（Ctrl+C abort）时取消挂起的提问——防 overlay 残留挡输入
        const signal = abortRef.current.signal
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort)
          pickerRef.current = false
          setOverlay(null)
        }
        const onAbort = (): void => {
          cleanup()
          resolve({ kind: 'cancel' })
        }
        if (signal.aborted) {
          resolve({ kind: 'cancel' })
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pickerRef.current = true
        setOverlay({
          kind: 'question-panel',
          questions,
          resolve: (r) => {
            cleanup()
            resolve(r)
          },
        })
      })
    })
    return () => setAskUserHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次
  }, [])

  /** 蒸馏预览确认（复用 active.confirm 通道；合成 use 走 ConfirmPrompt 默认渲染分支） */
  const askPreviewConfirm = (preview: string, what: string): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmRef.current = true
      setActive((a) => ({
        ...a,
        confirm: {
          use: { type: 'tool_use', id: `skill-create-${Date.now()}`, name: what, input: {} },
          preview,
          resolve,
        },
      }))
    })
  }

  /** M6 M-P6：/mcp reconnect 直达（面板外子命令） */
  const mcpReconnect = async (name?: string): Promise<void> => {
    if (deps.mcpManager === null) {
      setSystemMsgs(['（MCP 未启用）'])
      return
    }
    setSystemMsgs([`正在重连${name !== undefined && name !== '' ? ` ${name}` : '全部'} MCP server...`])
    try {
      const r = await deps.mcpManager.reconnect(name)
      setSystemMsgs([
        r.failed.length === 0
          ? `✓ MCP 重连完成（${r.ok.length} 个成功）`
          : `MCP 重连：成功 ${r.ok.length} 个 / 失败 ${r.failed.length} 个（${r.failed.map((f) => `${f.name}: ${f.error}`).join('；')}）`,
      ])
    } catch (e) {
      // 未知 server 名/内部错误透传（审阅 P2：吞错会渲染成「0 个成功」的假成功）
      setSystemMsgs(['MCP 重连失败：' + (e instanceof Error ? e.message : String(e))])
    }
  }

  /** M6 S-P7：/skill-create——读会话 → LLM 起草 → 预览 → 创建/升级（人审卡点两处） */
  const skillCreate = async (): Promise<void> => {
    if (!config.providers[config.current.name]) return
    const msgs = buildContextMessages(messagesRef.current)
    if (msgs.length === 0) {
      setSystemMsgs(['（会话为空，先聊几轮再 /skill-create 蒸馏）'])
      return
    }
    setSystemMsgs(['正在从会话起草 skill...'])
    try {
      const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
      const providerReq = buildProviderReq(config)
      const userMsg = (text: string): Message => ({
        role: 'user',
        content: [{ type: 'text', text }],
      })
      const raw = await callLLM(provider, providerReq, DRAFT_SYSTEM, [userMsg(buildDraftUser(serializeSession(msgs)))])
      const candidate = parseCandidate(raw)
      const existing = deps.skillRegistry.get(candidate.name)
      if (existing === undefined) {
        // 创建路径：选存储层级（用户级=个人 ~/.ecode/skills；项目级=团队共享 .ecode/skills 入库）
        const where = await askSelect('存储位置', ['用户级（个人，~/.ecode/skills）', '项目级（团队共享，.ecode/skills 入库）'])
        if (where === undefined) {
          setSystemMsgs(['（已放弃起草）'])
          return
        }
        const level = where.startsWith('项目级') ? ('project' as const) : ('user' as const)
        const ok = await askPreviewConfirm(renderCreatePreview(candidate), 'skill-create')
        if (!ok) {
          setSystemMsgs(['（已放弃起草；可调整会话后再跑 /skill-create）'])
          return
        }
        const r = await deps.skillRegistry.install(candidate, [], level)
        setSystemMsgs([`✓ 已创建 skill「${candidate.name}」（${level === 'project' ? '项目级' : '用户级'}：${r.path}）`])
      } else {
        // 升级路径：merger 三态 → 冲突裁决 → diff 预览 → install
        const mRaw = await callLLM(
          provider,
          providerReq,
          MERGER_SYSTEM,
          [userMsg(buildMergerUser(existing, candidate))],
        )
        const verdicts = parseMergerVerdicts(mRaw)
        const conflicts = conflictTitles(verdicts)
        let resolution: 'keep' | 'adopt' = 'keep'
        if (conflicts.length > 0) {
          const pick = await askSelect(
            `「${candidate.name}」升级有 ${conflicts.length} 处冲突：${conflicts.join('、')}`,
            ['保留现有（推荐）', '采用新'],
          )
          if (pick === undefined) {
            setSystemMsgs(['（已放弃升级）'])
            return
          }
          resolution = pick.startsWith('保留') ? 'keep' : 'adopt'
        }
        const ok = await askPreviewConfirm(renderUpgradePreview(candidate, verdicts, resolution), 'skill-create')
        if (!ok) {
          setSystemMsgs(['（已放弃升级；可再跑 /skill-create 重试）'])
          return
        }
        const r = await deps.skillRegistry.install(
          { ...candidate, body: patchBodyFromVerdicts(candidate.body, verdicts, resolution) },
          decisionsFromVerdicts(verdicts, resolution),
        )
        setSystemMsgs([
          r.mode === 'upgraded'
            ? `✓ 已升级 skill「${candidate.name}」（旧版备份：${r.backedUpTo}）`
            : `✓ 已创建 skill「${candidate.name}」（${r.path}）`,
        ])
      }
    } catch (e) {
      setSystemMsgs(['蒸馏失败：' + (e instanceof Error ? e.message : String(e))])
    }
  }

  /** M5：手动 /compact——触发编排器强制压缩 + 重建 committed（boundary 追加到 messagesRef） */
  const compactManual = async (): Promise<void> => {    if (messagesRef.current.length === 0) {
      setSystemMsgs(['（无可压缩对话）'])
      return
    }
    if (!config.providers[config.current.name]) return
    setSystemMsgs(['正在压缩对话...'])
    try {
      const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
      const providerReq = buildProviderReq(config)
      const lenBefore = messagesRef.current.length
      const onCompacted = (m: HistoryLine[]) => setCommitted(messagesToCommitted(m))
      const hook = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, buildSystemPrompt(deps.skillRegistry.listForPrompt(), ctxWindowRef.current), {
        onCompacted,
        history: deps.history,
        tools: deps.tools.specs(),
      })
      await hook(messagesRef.current, 'manual') // manual = 强制压缩 + 重置熔断（用户明确要求时给机会）
      setSystemMsgs(
        messagesRef.current.length > lenBefore
          ? ['✓ 已压缩对话（旧消息已摘要进上下文，原文仍显示）']
          : ['（未压缩——对话太短或摘要失败）'],
      )
    } catch (e) {
      setSystemMsgs(['压缩失败：' + (e instanceof Error ? e.message : String(e))])
    }
  }

  /** M5：切换 model 后检测 context 是否超新窗口（只提示风险，不自动压缩；用户主动 /compact） */
  const checkModelWindow = async (model: string, providerName: string): Promise<void> => {
    const ctxTokens = estimateContextTokens(
      buildSystemPrompt(deps.skillRegistry.listForPrompt(), ctxWindowRef.current),
      buildContextMessages(messagesRef.current),
      deps.tools.specs(), // MCP 工具 schema 同样计入（v6 修复记录「两个调用点」的第二处，审阅补漏）
    )
    const newWindow = await resolveContextWindow(model, config.providers[providerName]?.contextWindow)
    ctxWindowRef.current = newWindow // S-P4：切模型刷新缓存（后续 submit 的 skill 清单预算随之适配）
    const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(0)}k`)
    if (ctxTokens > newWindow) {
      setBanner(
        `当前对话（约 ${fmt(ctxTokens)} tokens）超出 ${model} 窗口（${fmt(newWindow)}）。建议 /compact 压缩后继续（注意：压缩有损，可能丢失细节），或 /clear 起新会话。`,
      )
    } else {
      setBanner(undefined)
    }
  }

  const restoreSession = (sessionId: string) => {
    // P0-3：用 restoreFull（含 boundary），让压缩态跨重启存活；restore() 过滤 boundary 会导致恢复即超限
    const messages = deps.history.restoreFull(sessionId)
    // P1-10：restore 返回空（文件缺失/损坏/真空会话）→ 保留当前会话 + 提示，不静默清空
    if (messages.length === 0) {
      setSystemMsgs(['⚠ 恢复失败：该会话为空或已损坏（文件缺失/无消息），未切换'])
      return
    }
    messagesRef.current = messages
    setCommitted(messagesToCommitted(messages))
    resetTransient()
    // 续写进新文件（起新 sessionId）；model 用当前 config（用户可能已 /model 切过）
    const newId = new Date().toISOString().replace(/[:.]/g, '-')
    // M9-P2：快照目录拷贝跟随（起新 id 后旧快照仍可用——否则「跨重启可回退」落空，CC copyFileHistoryForResume 同款）
    const oldId = deps.history.currentSessionId()
    deps.history.setSessionId(newId, config.current.model)
    deps.checkpoint
      ?.copyForResume(oldId, newId)
      .catch((e: unknown) =>
        pushNoticeFn('warn', `快照跟随失败（恢复会话后旧快照不可用）：${e instanceof Error ? e.message : String(e)}`),
      )
    // SessionStart hook（H-P4）：恢复会话 = resume
    void deps.hookRunner
      ?.dispatch('SessionStart', { event: 'SessionStart', session_id: '', source: 'resume' })
      .then((v) => {
        if (v.systemMessages.length > 0) setSystemMsgs(v.systemMessages)
        // M9-P0：additionalContext 暂存，恢复后首轮 user 消息注入（典型用途：会话环境信息）
        if (v.additionalContext.length > 0) pendingSessionCtxRef.current = v.additionalContext
      })
      .catch(() => {})
  }
  const { warning } = useInterrupt({
    onInterrupt: () => abortRef.current.abort(),
    // P0#1：confirm/picker 覆盖期间不 abort（由覆盖组件独占 Ctrl+C）
    isActive: () => confirmRef.current || pickerRef.current,
    // 双击退出走 cli 的优雅关闭（SessionEnd hooks / MCP stop 预算内完成后才退）；
    // 未注入（测试/独立渲染）保持 process.exit(0) 直退
    ...(onExit !== undefined ? { onExit } : {}),
  })

  // ctxWindow 缓存初始化（S-P4）：启动解析一次（models.dev 预热已由 M5 #4 修复），失败保持默认
  useEffect(() => {
    void resolveContextWindow(config.current.model, config.providers[config.current.name]?.contextWindow)
      .then((w) => {
        ctxWindowRef.current = w
      })
      .catch(() => {})
    // SessionStart hook（H-P4）：挂载即 startup
    void deps.hookRunner
      ?.dispatch('SessionStart', { event: 'SessionStart', session_id: '', source: 'startup' })
      .then((v) => {
        if (v.systemMessages.length > 0) setSystemMsgs(v.systemMessages)
        // M9-P0：additionalContext 暂存，启动后首轮 user 消息注入
        if (v.additionalContext.length > 0) pendingSessionCtxRef.current = v.additionalContext
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅启动一次
  }, [])

  // M9-P5：权限 ask 桥（扩展源 hook 首次执行前的确认弹窗；卸载置 null——argv/测试 ask 默认拒绝）
  useEffect(() => {
    setPermissionAsker((owner, event) =>
      new Promise((resolveAsk) => {
        confirmRef.current = true
        setActive((a) => ({
          ...a,
          confirm: {
            use: { type: 'tool_use', id: `perm-${owner}`, name: `hook:${owner}`, input: {} },
            preview: `扩展 ${owner} 申请在 ${event} 事件执行 hook（首次）`,
            rememberLabel: '永久记住（写入 settings.local.json）',
            resolve: (ok, always) => resolveAsk({ allow: ok, remember: always === true }),
          },
        }))
      }),
    )
    return () => setPermissionAsker(null)
  }, [])

  // M11-P4/P5：子代理桥——confirm 串行队列（单槽覆盖式并发必炸，方案 §1.3）+ warn/usage/progress 转发
  useEffect(() => {
    setSubagentBridge({
      confirm: queueConfirm(doConfirm),
      warn: (m) => pushNoticeFn('warn', m),
      usage: (inp, out, cache) => recordUsage(inp, out, cache),
      // 审阅 P0-2：子代理写前走 TuiApp 版（editedFilesRef 归主——父轮末 autoCommit 提交集）
      onBeforeWrite: async (paths, tool, toolUseId) => {
        for (const p of paths) editedFilesRef.current.add(p)
        await deps.checkpoint?.snapshot(deps.history.currentSessionId(), paths, { tool, messageId: toolUseId })
      },
      // 审阅 P1-1/P1-2：运行态 getter（/model·/config 切换、Tab 切沙箱档后子代理取新值——
      // config 是 TuiApp state 天然新；cli deps 闭包是 makeDeps 时的旧对象）
      getProviderReq: () => buildProviderReq(config),
      getProvider: () => deps.providerRegistry.getByType(config.providers[config.current.name].type),
      getSandbox: () =>
        makeSandbox(sandboxModeRef.current, process.cwd(), config.sandbox?.blockedCommands ?? []),
      getModel: () => config.current.model,
    })
    setSubagentProgressHandler(setSubagents)
    return () => {
      setSubagentBridge(null)
      setSubagentProgressHandler(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（pushNoticeFn/recordUsage 稳定引用）
  }, [])

  // M6 M-P7：MCP 状态订阅（onEvent → setState → StatusBar/面板读快照）+ 启动警告
  const [mcpSnapshots, setMcpSnapshots] = useState<McpServerSnapshot[]>(() => deps.mcpManager?.status() ?? [])
  const [, setMcpApproving] = useState(false)

  useEffect(() => {
    const mgr = deps.mcpManager
    if (mgr == null) return // null/undefined 都视为未启用（防御内联 deps 漏传）
    setMcpSnapshots(mgr.status())
    const unsub = mgr.subscribe(() => setMcpSnapshots(mgr.status()))
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 不变（挂载期一次）
  }, [])
  // MCP 启动警告 + M8 指令/记忆截断提示 → 告警中心（M8②：统一队列，底部行+/warnings 可见）
  useEffect(() => {
    for (const w of [...(deps.mcpWarnings ?? []), ...(deps.instructionWarnings ?? [])]) {
      pushNoticeFn('warn', w)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次
  }, [])

  // M7 P4.5：skill 同名冲突底部汇总（非阻断——计数只认 skill 间遮蔽，命令遮蔽不算；引导自然语言消解）
  useEffect(() => {
    const count = deps.skillRegistry.shadowedEntries.length
    if (count === 0) return
    setSystemMsgs((prev) => [
      ...prev,
      `${count} 个 skill 同名冲突（/skill 查看详情；可直接让我改名或删除其一）`,
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次
  }, [])

  useEffect(() => {
    const pending = deps.mcpPendingApproval
    if (pending === undefined) return
    setSystemMsgs([`检测到项目级 ${pending.file}，需要批准后才会连接 MCP server`])
    setMcpApproving(true)
    void (async () => {
      const pick = await askSelect(`批准项目级 ${pending.file}？（含 MCP server 定义，可 spawn 子进程）`, [
        '批准并连接',
        '本次会话不连接',
      ])
      if (pick !== undefined && pick.startsWith('批准')) {
        try {
          await pending.approve()
          setSystemMsgs(['✓ 已批准并接入项目级 MCP server'])
        } catch (e) {
          setSystemMsgs(['接入失败：' + (e instanceof Error ? e.message : String(e))])
        }
      } else {
        setSystemMsgs(['（本次会话未连接项目级 MCP；下次启动会再询问）'])
      }
      setMcpApproving(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（二段启动，M4.1）
  }, [])

  // Ctrl+O：toggle 当前轮工具展开/收起（只对有 use 的 done 工具）
  const toggleExpand = () => {
    setActive((a) => {
      const dones = a.tools.filter((t) => t.use)
      if (dones.length === 0) return a
      const allExpanded = dones.every((t) => a.expandedTools.has(t.use!.id))
      const next = new Set<string>(allExpanded ? [] : dones.map((t) => t.use!.id))
      return { ...a, expandedTools: next }
    })
  }

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') toggleExpand()
    },
    // P2-4：overlay/confirm 期间不抢 Ctrl+O（picker/confirm 独占输入）
    { isActive: overlay === null && active.confirm === null },
  )

  // M6 M-P7：StatusBar MCP 段（有启用的 server 才显示；连接中瞬时态）
  const mcpSegment = useMemo(() => {
    if (mcpSnapshots.length === 0) return undefined
    const enabled = mcpSnapshots.filter((s) => s.status !== 'disabled')
    if (enabled.length === 0) return undefined
    if (enabled.some((s) => s.status === 'connecting')) return 'MCP 连接中…'
    const connected = enabled.filter((s) => s.status === 'connected').length
    return `MCP ${connected}/${enabled.length}`
  }, [mcpSnapshots])

  const busy =
    active.streamingText !== '' ||
    activity.state === 'thinking' ||
    activity.state === 'tool' ||
    activity.state === 'retry'

  // systemMsgs（命令反馈）不进 committed——是即时系统消息（非对话历史），
  // 独立渲染在 InputStream 上方（见 return），避免压在当前轮对话之上
  const fullCommitted: CommittedItem[] = committed

  const hasDoneTool = active.tools.some((t) => t.use)

  // /model 可选项：providers 笛卡尔积（name × models），方案 §8.2
  const entries: ModelEntry[] = []
  for (const [name, cfg] of Object.entries(config.providers)) {
    for (const model of cfg.models) {
      entries.push({ name, model })
    }
  }

  return (
    <App
      key={clearKey}
      model={config.current.model}
      banner={banner}
      committed={fullCommitted}
      active={active}
      onToggleTool={hasDoneTool ? toggleExpand : undefined}
      onConfirm={clearConfirm}
      onCancel={clearConfirm}
      activity={activity.state}
      activityText={activity.text}
      mcp={mcpSegment}
      sandbox={sandboxMode === 'default' ? undefined : sandboxMode}
      sandboxDanger={sandboxMode === 'full-access'}
      tokens={tokens}
      iter={iter}
      maxIter={maxIter}
      warningLevel={(() => {
        const l = deriveNoticeLine(notices)
        return l === null || warning !== undefined ? undefined : l.level
      })()}
      warning={
        warning ?? (() => {
          const line = deriveNoticeLine(notices)
          return line === null ? undefined : renderNoticeLine(line, process.stdout.columns ?? 100)
        })()
      }
    >
      <SubagentBar agents={subagents} />
      {interjectPreview !== null && (
        <Box paddingLeft={1}>
          <Text dimColor>
            已排队：{interjectPreview.slice(0, 40)}
            {interjectQueueRef.current.length > 1 ? `（共 ${interjectQueueRef.current.length} 条）` : ''}
            （Ctrl+U 清空）
          </Text>
        </Box>
      )}
      {error ? <ErrorBanner error={error} /> : null}
      {overlay?.kind === 'model-picker' && (
        <ModelPicker
          entries={entries}
          current={config.current}
          onPick={(e) => {
            setConfig((c) => ({ ...c, current: { name: e.name, model: e.model } }))
            pickerRef.current = false
            setOverlay(null)
            void checkModelWindow(e.model, e.name)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'pick-history' && (
        <HistoryPicker
          metas={historyMetas}
          onSelect={(sid) => {
            restoreSession(sid)
            pickerRef.current = false
            setOverlay(null)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'setup-wizard' && (
        <Wizard
          existingProviders={Object.entries(config.providers).map(([name, cfg]) => ({ name, cfg }))}
          onComplete={(values) => {
            // P1-6：write + reload 都进 try——写失败（空值校验/只读/磁盘满）→ banner 提示，不崩 TUI
            try {
              writeWizardConfig(values)
              setConfig(loadConfig())
              setBanner(undefined)
            } catch (e) {
              setBanner(e instanceof Error ? e.message : String(e))
            }
            pickerRef.current = false
            setOverlay(null)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'skill-panel' && (
        <SkillPanel
          skills={deps.skillRegistry.listForCompletion()}
          onPick={(fill) => {
            // D32：回填输入框（带尾随空格留传参位），不直接执行
            setInsert({ text: fill, seq: Date.now() })
            pickerRef.current = false
            setOverlay(null)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'mcp-panel' && (
        <McpPanel
          snapshots={mcpSnapshots}
          onReconnect={async (n) => {
            await deps.mcpManager?.reconnect(n)
          }}
          onDisconnect={async (n) => {
            await deps.mcpManager?.close(n)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
          toolsOf={(n) => deps.mcpManager?.toolsOf(n) ?? []}
        />
      )}
      {overlay?.kind === 'plugin-panel' && deps.pluginLoader != null && (
        <PluginPanel
          key={pluginPanelKey}
          loader={deps.pluginLoader}
          skillRegistry={deps.skillRegistry}
          tools={deps.tools}
          mcp={deps.mcpManager}
          refresh={() => setPluginPanelKey((k) => k + 1)}
          notify={(m) => setSystemMsgs([m])}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'select' && (
        <Select
          title={overlay.title}
          items={overlay.options.map((o) => ({ label: o, value: o }))}
          onSelect={(v) => {
            overlay.resolve(v)
            pickerRef.current = false
            setOverlay(null)
          }}
          onCancel={() => {
            overlay.resolve(undefined)
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'config-panel' && (
        <ConfigPanel
          current={{ provider: config.current.name, model: config.current.model }}
          providers={Object.entries(config.providers).map(([name, p]) => ({
            name,
            type: p.type,
            models: p.models,
            baseURL: p.baseURL,
            hasKey: p.apiKey !== undefined && p.apiKey !== '',
          }))}
          general={generalConfigItems(config)}
          onSave={async (key, value) => {
            try {
              await saveConfigKey(key, value)
              pushNoticeFn('info', `已保存 ${key}（落盘为启动默认；当前会话不受影响，重启或 /restart 生效）`)
            } catch (e) {
              pushNoticeFn('warn', `保存失败：${e instanceof Error ? e.message : String(e)}`)
            }
          }}
          onClose={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'sandbox-panel' && (
        <SandboxPanel
          current={sandboxMode}
          onPick={(mode) => {
            pickerRef.current = false
            setOverlay(null)
            if (mode === null) return
            applySandboxMode(mode)
            setSystemMsgs([mode === 'default' ? '沙箱模式：default（现状，写/bash 每次确认）' : `沙箱模式：已切换到 ${mode}`])
          }}
        />
      )}
      {overlay?.kind === 'rewind-panel' && (
        <RewindPanel
          store={deps.checkpoint ?? null}
          sessionId={deps.history.currentSessionId()}
          disabled={runningRef.current}
          onDone={(r) => {
            pickerRef.current = false
            setOverlay(null)
            if (r === null) return
            const line: RewindLine = { rewind: true, seq: r.seq, toolUseId: r.toolUseId, time: new Date().toISOString() }
            messagesRef.current = [...messagesRef.current, line]
            deps.history.appendRewind(line)
            setCommitted(messagesToCommitted(messagesRef.current))
            setSystemMsgs([`⇺ 已回退至快照点 ${r.seq}（还原 ${r.restoredCount} 个文件；该点之后的对话不再进入上下文，原文仍可回看）`])
          }}
        />
      )}
      {overlay?.kind === 'warnings-panel' && (
        <WarningsPanel
          notices={notices}
          onClear={() => {
            setNotices([])
            pickerRef.current = false
            setOverlay(null)
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
        />
      )}
      {overlay?.kind === 'question-panel' && (
        <QuestionPanel
          questions={overlay.questions}
          resolve={overlay.resolve}
          onCancel={() => overlay.resolve({ kind: 'cancel' })}
        />
      )}
      {systemMsgs.length > 0 && (
        <Box flexDirection="column">
          {systemMsgs.map((m, i) => (
            <Text key={`sys${clearKey}_${i}`} dimColor>
              {m}
            </Text>
          ))}
        </Box>
      )}
      <InputStream
        onSubmit={submit}
        onPasteImage={() => pasteImageFromClipboard()}
        onInterjectClear={() => {
          interjectQueueRef.current.length = 0
          setInterjectPreview(null)
        }}
        busy={runningRef.current}
        onSlashBusy={() => setSystemMsgs(['运行中暂不能执行命令（空闲后再发；插话请直接输入文字）'])}
        onTabSandbox={() => {
          // M9-D13：Tab 专职循环切档；D12：进 full-access 需确认——循环到该档时打开面板二级确认
          const next = nextSandboxMode(sandboxModeRef.current)
          if (next === 'full-access') {
            pickerRef.current = true
            setOverlay({ kind: 'sandbox-panel' })
            return
          }
          applySandboxMode(next)
          setSystemMsgs([`沙箱模式：${next}${next === 'default' ? '（写/bash 每次确认）' : ''}`])
        }}
        onSkillInvoke={(name, args) => {
          // S4.4 手动触发：展开全文作 userInput，原始 `/name args` 作 display
          const info = deps.skillRegistry.get(name)
          if (info === undefined) return
          // M7 H-P5：skill 附带 hooks → 会话级注册 + 底部告知（与 LLM 面同语义）
          if (info.hooks !== undefined && info.hooks.length > 0) {
            registerSkillHooks(info.name, info.hooks)
            setSystemMsgs([`skill「${name}」已启用 ${info.hooks.length} 个 hooks（本会话）`])
          }
          void submit(
            expandSkill(info, args),
            `/${name}${args !== undefined && args !== '' ? ` ${args}` : ''}`,
          )
        }}
        onCommand={(_cmd, result) => {
          if (result.action === 'expand') {
            toggleExpand()
            return
          }
          if (result.action === 'skill-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'skill-panel' })
            return
          }
          if (result.action === 'pick-model') {
            pickerRef.current = true
            setOverlay({ kind: 'model-picker' })
            return
          }
          if (result.action === 'pick-history') {
            setHistoryMetas(deps.history.loadAll())
            pickerRef.current = true
            setOverlay({ kind: 'pick-history' })
            return
          }
          if (result.action === 'start-setup') {
            pickerRef.current = true
            setOverlay({ kind: 'setup-wizard' })
            return
          }
          if (result.action === 'compact') {
            void compactManual()
            return
          }
          if (result.action === 'skill-create') {
            void skillCreate()
            return
          }
          if (result.action === 'open-mcp-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'mcp-panel' })
            return
          }
          if (result.action === 'mcp-reconnect') {
            void mcpReconnect(result.payload)
            return
          }
          if (result.action === 'inject-prompt') {
            // /doctor 等：预填检查指令直接提交（用户看到指令全文再由 LLM 执行）
            if (result.payload !== undefined && result.payload !== '') void submit(result.payload, '/doctor') // display 分离：转录显示命令名，不刷屏 800 字全文
            return
          }
          if (result.action === 'open-warnings-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'warnings-panel' })
            return
          }
          if (result.action === 'open-config-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'config-panel' })
            return
          }
          if (result.action === 'git-undo') {
            void undoEcodeCommit(process.cwd()).then((r) => {
              pushNoticeFn(r.ok ? 'info' : 'warn', r.message)
            })
            return
          }
          if (result.action === 'open-sandbox-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'sandbox-panel' })
            return
          }
          if (result.action === 'open-rewind-panel') {
            if (deps.checkpoint == null) {
              setSystemMsgs(['快照系统未启用（argv 模式）'])
              return
            }
            pickerRef.current = true
            setOverlay({ kind: 'rewind-panel' })
            return
          }
          if (result.action === 'open-plugin-panel') {
            if (deps.pluginLoader == null) {
              setSystemMsgs(['plugin 系统未启用'])
              return
            }
            pickerRef.current = true
            setPluginPanelKey((k) => k + 1)
            setOverlay({ kind: 'plugin-panel' })
            return
          }
          if (result.action === 'restart') {
            if (onRestartRef.current === undefined) {
              setSystemMsgs(['当前模式不支持重启（请手动重新运行 ecode）'])
              return
            }
            setSystemMsgs(['正在重启 ECode…（会话历史已保存，/history 可恢复）'])
            // 短暂展示提示后执行（cli 注入的重启句柄：unmount + spawn 新实例 + exit）
            setTimeout(() => onRestartRef.current?.(), 400)
            return
          }
          if (result.action === 'cost') {
            const u = deps.lastUsage
            const lineCost = tokensToCost(config.current.model, {
              input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreation: u.cacheCreation,
            }, config.providers[config.current.name]?.pricing)
            setSystemMsgs(
              lineCost == null
                ? [
                    `本轮 token：input ${u.input} / output ${u.output} / cache_read ${u.cacheRead} / cache_creation ${u.cacheCreation}`,
                    '会话累计成本：成本未知（模型未收录定价，可在 config 配 contextWindow）',
                  ]
                : [
                    `本轮 token：input ${u.input} / output ${u.output} / cache_read ${u.cacheRead} / cache_creation ${u.cacheCreation}`,
                    `会话累计成本：¥${sessionCost.toFixed(4)}`,
                  ],
            )
            return
          }
          // 替换（不累积）：多次 /help 只显示最新
          setSystemMsgs(result.output ? [result.output as string] : [])
        }}
        onClear={() => {
          messagesRef.current = []
          setCommitted([])
          resetTransient()
        }}
        // M11-P7：忙碌态保持激活（插话 Enter 入队；overlay/confirm 仍独占）
        inactive={overlay !== null || active.confirm !== null}
        insert={insert}
        placeholder={busy ? '（处理中，Ctrl+C 中断）...' : '输入消息，/help 查看命令...'}
      />
    </App>
  )
}
