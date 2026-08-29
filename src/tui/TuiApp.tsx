import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput, Text, Box } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { HostSession } from '../host/session.js'
import type { ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, ContentBlock, HistoryLine, ImageBlock, Message, RewindLine } from '../core/types.js' 
import type { ToolUseBlock } from '../core/types.js'
import { tokensToCost } from '../services/pricing.js'
import { buildContextMessages } from '../core/context.js'
import { estimateContextTokens } from '../services/tokenizer.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { createActive, nextSingleExpand, type CommittedItem, type ActiveState } from './types.js'
import { messagesToCommitted } from './commit.js'
import { buildSystemPrompt } from '../core/system.js'
import { expandSkill, type SkillRegistry } from '../services/skill.js'
import { globalSkillHooks } from '../services/hooks/global.js'
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
import { nextSandboxMode, type SandboxMode } from '../services/sandbox.js'
import type { SubagentStatus } from '../services/subagent.js'
import { SubagentBar } from './SubagentBar.js'
import { TasksBar } from './TasksBar.js'
import { OutputListPage, OutputViewer, toolResultSource, taskFileSource, subagentSource, type OutputEntry, type RecentTool } from './OutputViewer.js'
import { taskRegistry } from '../services/tasks.js'
import { undoEcodeCommit } from '../services/git.js'
import { readClipboardImage } from '../services/clipboard.js'
import { pushNotice, deriveNoticeLine, renderNoticeLine, type NoticeItem, type NoticeLevel } from './notices.js'
import type { AskUserQuestion, AskUserResult } from '../tools/builtin/ask_user.js'
import { Select } from './Select.js'
import type { McpManager, McpServerSnapshot } from '../services/mcp/manager.js'
import type { SessionMeta } from '../services/history.js'
import type { InputDraftPort } from './draftPort.js'

/**
 * 主输入框草稿权威端口（审阅 P1-1 方案 B）：
 * 既有通道已有三处权威镜像 InputDraft（insert prop / handleTextSubmit / setCur），此处只挂第四处。
 * TuiApp 挂载时注册（InputStream 渲染闭包捕获 setCur），卸载时注销——多实例并存测试期间
 * 遵循「最后挂载者拥有读权」（与 ink-testing 每测 unmount 后重挂的现实一致）。
 */
const draftPortRef: { current: InputDraftPort | null } = { current: null }
function registerDraftPort(port: InputDraftPort | null): void {
  draftPortRef.current = port
}

/** setInsert seq 生成（P2-4）：Date.now 同毫秒碰撞会被 InputStream 幂等忽略（丢一次可见回显）
 * ——模块级单调递增计数器（TuiApp 实例单例，计数器跨实例单调更稳） */
let insertSeqCounter = 0
function nextInsertSeq(): number {
  insertSeqCounter += 1
  return insertSeqCounter
}

/** 清屏（可见区 + scrollback + 光标归位）；/clear 用，清可见区残留 */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H'

/** 批2d（§13.1 拍板-1 附）：BEL 终端铃字符（审批卡首次出现时写一次，终端自行决定响/闪标题栏） */
const BEL_CHAR = '\x07'

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
  /** M13-W1：项目宿主（会话容器——构造走它；测试 fake 缺省走内联构造兜底） */
  project?: import('../host/project.js').ProjectHost
  /** M13-W1：skill hooks 写端口（项目级 registry 绑定；缺省走模块兜底端口） */
  skillHooks?: import('../services/hooks/global.js').SkillHooksPort
}


/** M10-P2：常规页可编辑项（从 config 派生；值展示 + 档位循环） */
function generalConfigItems(config: import('../services/config.js').Config): ConfigItem[] {
  return [
    { key: 'maxIterations', label: 'maxIterations（每轮最大迭代）', value: String(config.maxIterations), options: ['20', '50', '100', '200'], kind: 'enum' },
    { key: 'autoCommit', label: 'autoCommit（编辑轮末自动 git 提交）', value: String(config.autoCommit === true), options: ['false', 'true'], kind: 'toggle' },
    { key: 'webSearch.provider', label: 'webSearch.provider（搜索引擎）', value: config.webSearch?.provider ?? 'bing', options: ['bing', 'zhipu'], kind: 'enum' },
    // F-25（功能测试批）：文案对齐 M9 实际语义——空/缺省=关闭（不自动探测，防 npm-scripts RCE 链），改值走原始 config
    { key: 'lintCommand', label: 'lintCommand（空=关闭，改值开原始 config）', value: config.lintCommand ?? '', kind: 'readonly' },
  ]
}



/**
 * TuiApp：连接 AgentLoop 与 TUI（最小 Static 方案）。
 *
 * - committed：已固化的历史（进 <Static>，滚轮友好）
 * - active：当前轮活跃状态（分区累积：userInput / tools / streamingText）
 * - 一轮一 commit：runLoop 结束 → messagesToCommitted → setCommitted；active 清空
 */
export function TuiApp({ deps, banner: initialBanner, onRestart, onExit, initialHistorySessionId }: { deps: TuiAppDeps; banner?: string; onRestart?: () => void; onExit?: () => void; initialHistorySessionId?: string }): ReactElement {
  const abortRef = useRef<AbortController>(new AbortController())
  // M12-B3 中间态：客户端消息镜像（宿主 transcript 权威；轮末/压缩/恢复同步——B5 退役）
  const messagesRef = useRef<HistoryLine[]>([])
  const runningRef = useRef(false)
  // 同步 confirm 状态给 useInterrupt isActive（避免 stale closure；P0#1）
  const confirmRef = useRef(false)
  // 审阅 P1-1（草稿状态机重设计，方案 B）：不维护独立镜像——草稿判定直接引用主输入框
  // 权威值（readMainDraft 经 draftPort 挂 InputStream 的 cur）。三个好处：卡弹出前 busy
  // 输入框已有的字自然成为草稿基线（不再从空串起步覆写可见文本 abc→d）；用户编辑/清空/
  // 提交输入框后判定自动跟随（不再有「带草稿 Esc 后 hasDraft 假阳性/陈旧草稿被 Enter
  // 当插话提交」）；应答时同步清输入框（卡语义终点的 UI 一致）。以下局部 ref/函数仅为
  // 回调闭包提供稳定的同步读（渲染路径一律走 readMainDraft()，不走 state 镜像）
  const clearMainDraft = (): void => {
    setInputDraft({ text: '', seq: nextInsertSeq() })
  }
  const readMainDraft = (): string => draftPortRef.current?.read() ?? ''
  // M12-B3：插话预览由宿主 queue/snapshot 事件镜像（队列权威在宿主，D2）
  const [interjectPreview, setInterjectPreview] = useState<string | null>(null)
  const enqueueInterject = async (text: string, images?: { path: string; mime: string; label?: string }[]): Promise<void> => {
    // 斜杠拦截不在此（InputStream 分流点已拦）；F2：入队时过 UserPromptSubmit hook
    // （宿主仅新轮 dispatch——插话注入不走宿主 hook，此处保留客户端 dispatch 维持旧行为）
    let finalText = text
    if (deps.hookRunner != null && deps.hookRunner.hasHandlers('UserPromptSubmit')) {
      const verdict = await deps.hookRunner.dispatch(
        'UserPromptSubmit',
        { event: 'UserPromptSubmit', session_id: deps.history.currentSessionId(), prompt: text },
        { signal: abortRef.current.signal },
      )
      if (verdict.block) {
        setSystemMsgs([`✋ 插话被 hook 拦截${verdict.reason !== undefined && verdict.reason !== '' ? `：${verdict.reason}` : ''}`])
        return
      }
      if (verdict.additionalContext.length > 0) finalText = `${finalText}\n\n[hook context]\n${verdict.additionalContext.join('\n')}`
    }
    const r = await host.send({ op: 'prompt', text: finalText, mode: 'StartOrSteer', ...(images !== undefined && images.length > 0 ? { images } : {}) })
    if (!r.ok) setSystemMsgs([`插话失败：${r.error}`])
  }
  // M11-P4：运行中子代理快照（进度事件驱动）
  const [subagents, setSubagents] = useState<SubagentStatus[]>([])
  // 审阅 P1-1：TasksBar 活跃态（allocateDynamic 条件段扣减用——与 TasksBar 同源 1s 轮询）
  const [tasksActive, setTasksActive] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setTasksActive(taskRegistry.snapshot().length > 0), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])

  /** usage 记录（submit 与子代理桥共用——成本归并；「本轮」语义被并发稀释为最后到达者，文档化） */
  const recordUsage = (inp: number, out: number, cache?: { read?: number; creation?: number }) => {
    deps.lastUsage.input = inp
    deps.lastUsage.output = out
    deps.lastUsage.cacheRead = cache?.read ?? 0
    deps.lastUsage.cacheCreation = cache?.creation ?? 0
    setTokens((n) => n + inp + out)
    // P0 连带：定价读 configRef——本函数被挂载期子代理桥长期持有，闭包捕获的 config 是首次
    // 渲染值（/model 切换后仍按旧模型计价）
    const c = tokensToCost(configRef.current.current.model, {
      input: inp,
      output: out,
      cacheRead: cache?.read ?? 0,
      cacheCreation: cache?.creation ?? 0,
    }, configRef.current.providers[configRef.current.current.name]?.pricing)
    if (c != null) setSessionCost((sc) => sc + c)
  }
  // 同步 picker 覆盖状态给 useInterrupt（同 confirm：覆盖期间 Ctrl+C 由 picker 处理，不中断 loop）
  const pickerRef = useRef(false)
  // 批2d（§13.1 拍板-1 附）：已响铃的审批 requestId 留痕（同一审批不重复响——Set 随会话生命周期，无需清理）
  const bellRungRef = useRef(new Set<string>())
  // ctxWindow 缓存（S-P4：submit 热路径同步用，启动解析一次 + 切模型刷新；默认 200k 兜底）
  const ctxWindowRef = useRef(200_000)
  // SessionStart 的 additionalContext 暂存（M9-P0）：注入启动/恢复后首轮 user 消息，一次性消费
  const pendingSessionCtxRef = useRef<string[]>([])
  // M9-P6：本轮编辑文件集（onBeforeWrite 收集；autoCommit 开启时轮末提交+清空）
  // M10-P2b：待发送的粘贴图片（Alt+V 落盘后的路径；submit 时按文本引用组装 blocks 并清空）。
  // 真机修复批 v2（两家同款内嵌形态）：粘贴把短标签 [图片#N] 插入输入框文本，标签即引用——
  // 删标签=删图（提交剪枝），无独立附件行（v1 的输入框上方行已退役）
  // 值不读：v2 内嵌标签形态后 UI 不再渲染附件行（标签在输入框文本里，InputStream 自驱）；
  // setter 保留触发重渲染（粘贴/清空的 UI 时序与旧版一致）。数组权威源在下方 ref。
  const [, setPendingImages] = useState<Array<{ path: string; label: string }>>([])
  // P1 闭包竞态（全量测试 flake 根因）：Alt+V 粘贴后立刻 Enter 且 React 渲染未提交时，渲染闭包里
  // 的 pendingImages state 还是旧空数组——标签已进文本但图片块静默不附着。ref 为权威源（粘贴
  // 序号/submit 组装/清空点全读它），state 只是 UI 渲染镜像；两处同步双写。
  const pendingImagesRef = useRef<Array<{ path: string; label: string }>>([])

  /** M10-P2b：Alt+V 粘贴——读剪贴板图落附件目录，返回插入输入框的短标签（无图 null） */
  const pasteImageFromClipboard = async (): Promise<string | null> => {
    const img = await readClipboardImage(deps.history.currentSessionId())
    if (img === null) {
      setSystemMsgs(['剪贴板无图片（或读取失败）'])
      return null
    }
    // 序号读 ref（state 渲染闭包在快速连击 Alt+V 未提交时取旧 length，产生重复 [图片#N]）
    const label = `[图片#${pendingImagesRef.current.length + 1}]`
    pendingImagesRef.current = [...pendingImagesRef.current, { path: img.path, label }]
    setPendingImages(pendingImagesRef.current)
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
  // 运行态镜像（thread/status 驱动）：placeholder/快捷键提示的权威判据。
  // 旧判据 active.streamingText !== '' 在轮末延迟 commit 下永不清空——
  // 正常轮结束后输入框仍显示「处理中，Ctrl+C 中断」（中断观感根因之一）
  const [running, setRunning] = useState(false)
  const [maxIter, setMaxIter] = useState<number | undefined>(undefined)
  const [clearKey, setClearKey] = useState(0)
  // config 是 state 不是 props（§8.1.1）：/model 改 current → setConfig → 重渲染，下次 submit 用新 current
  const [config, setConfig] = useState<Config>(() => deps.config)
  // P0：configRef 双轨——挂载期 effect（子代理桥/权限桥等）与 recordUsage 闭包捕获首次渲染的 config
  // state，/model·/setup·/config 切换后 setConfig 换新对象但挂载期 effect 不重跑 → 桥上 getter
  // 永远返回旧值。ref 由 [config] effect 同步，跨渲染读最新；submit 等每次渲染新建的闭包不必须，
  // 但统一读 ref 免分叉。
  const configRef = useRef(config)
  useEffect(() => {
    configRef.current = config
  }, [config])
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
    | { kind: 'output-panel' }
    | { kind: 'output-view'; source: import('./OutputViewer.js').LineSource; title: string }
    | { kind: 'select'; title: string; options: string[]; resolve: (v: string | undefined) => void }
    // M8 ask_user：工具发起的提问面板（Promise 桥——resolve 回工具 execute）
    | { kind: 'question-panel'; questions: AskUserQuestion[]; resolve: (r: AskUserResult) => void }
    | null
  >(null)
  // M14-V3：最近工具调用环形缓冲（/output 列表数据源——item/completed 帧记录，50 封顶）
  const [recentTools, setRecentTools] = useState<RecentTool[]>([])
  // 审阅 P1-4：ref 镜像——toolResultSource 的 getter 经它取当前对象（补全 setRecentTools
  // 产生的新对象即时可见，不闭包打开时刻的快照）
  const recentToolsRef = useRef(recentTools)
  recentToolsRef.current = recentTools
  // 面板回填通道（S-P6 D32：SkillPanel Enter → `/name ` 写入输入框，不直接执行）。
  // 审阅 P1-1：此通道兼任「审批草稿 → 主输入框」的写通道（handleConfirmDraftKey 全走它）
  const [insert, setInputDraft] = useState<{ text: string; seq: number } | undefined>(undefined)
  // 审阅 P1-1：主输入框草稿 state 镜像（draftPort 挂 InputStream 时随 cur.text 同步——
  // 供 App→ConfirmPrompt 的 draft prop 判定 hasDraft；权威仍是 InputDraft.read()）
  const [mainDraft, setMainDraft] = useState('')
  const registerPort = useCallback((port: InputDraftPort | null): void => {
    registerDraftPort(port)
    setMainDraft(port?.read() ?? '')
  }, [])
  // /history 打开时载入的会话列表（loadAll 只在打开时调一次，避免 render 热路径同步 IO）
  const [historyMetas, setHistoryMetas] = useState<SessionMeta[]>([])
  // banner（配置无效提示；初始从 cli 传入，/setup 成功后清，submit 配置无效时设）
  const [banner, setBanner] = useState<string | undefined>(initialBanner)
  // /plugin 面板刷新 key（安装/启停操作后重查 browse/list——数据是 loader 现查的，靠 remount 重建）
  const [pluginPanelKey, setPluginPanelKey] = useState(0)
  // /restart 句柄经 ref（deps 闭包稳定，setTimeout 回调取最新）
  const onRestartRef = useRef(onRestart)

  // —— M12-B3：宿主会话（数据/执行/审批全权在宿主；TuiApp 只是协议客户端）——
  const hostRef = useRef<HostSession | null>(null)
  if (hostRef.current === null) {
    // M13-W1：宿主取自 ProjectHost（会话容器；首会话已由 makeDeps ensure——此处幂等取回）；
    // 测试 fake 无 project 走内联构造兜底（与 M12 等价）
    hostRef.current =
      deps.project !== undefined
        ? deps.project.ensureDefault(deps.history.currentSessionId())
        : new HostSession({
            providerRegistry: deps.providerRegistry,
            tools: deps.tools,
            logger: deps.logger,
            history: deps.history,
            getConfig: () => configRef.current,
            orchestrator: deps.orchestrator,
            skillListForPrompt: () => deps.skillRegistry.listForPrompt(),
            ...(deps.hookRunner != null ? { hookRunner: deps.hookRunner } : {}),
            ...(deps.checkpoint != null && deps.checkpoint !== undefined ? { checkpoint: deps.checkpoint } : {}),
            ...(deps.quality != null && deps.quality !== undefined ? { quality: deps.quality } : {}),
            ctxWindowHint: () => ctxWindowRef.current,
            cwd: process.cwd(),
          })
  }
  const host = hostRef.current

  // 事件→UI 映射（渲染/审批/插话/进度全事件驱动；回调直驱 setState 的旧路径退役）
  useEffect(() => {
    host.mountBridges()
    const unsub = host.subscribe((ev) => {
      switch (ev.type) {
        case 'delta':
          setActive((a) => ({ ...a, streamingText: a.streamingText + ev.text }))
          break
        case 'item/started':
          setActive((a) => ({ ...a, tools: [...a.tools, { name: ev.name, status: 'running', at: Date.now() }] }))
          setActivity({ state: 'tool', text: ev.name })
          break
        case 'item/completed': {
          // M14-V3：环形缓冲记录（/output 查看器数据源；前台 bash 有工具层 30KB 截断边界）
          setRecentTools((prev) => {
            const next = [{ itemId: ev.itemId, name: ev.name, content: ev.content, isError: ev.isError, at: Date.now(), ...(ev.truncated === true ? { truncated: true } : {}) }, ...prev]
            return next.length > 50 ? next.slice(0, 50) : next
          })
          // M14-C1⑤：帧 content 已截断 4KB——异步 item/read 补全全文（打开 /output 前通常已就绪）。
          // 审阅 P1-5：补全失败（压缩后 tool_result 已被摘要 ITEM_NOT_FOUND/未落盘窗口）与
          // 二次截断（>1MB）不再静默——告警中心提示 + truncated 标记保留（查看器标"截断"）
          if (ev.truncated === true) {
            void host.send({ op: 'item/read', itemId: ev.itemId }).then((r) => {
              const value = (r as { value?: { content?: unknown; truncated?: unknown } }).value
              if (r.ok && value !== undefined && typeof value.content === 'string') {
                setRecentTools((prev) => prev.map((t) => (t.itemId === ev.itemId ? { ...t, content: value.content as string, ...(value.truncated === true ? { truncated: true } : { truncated: false }) } : t)))
                if (value.truncated === true) {
                  pushNoticeFn('warn', `工具 ${ev.name} 全文超 1MB 上限，查看器仍为截断版（全文走后台任务日志）`)
                }
              } else {
                pushNoticeFn('warn', `工具 ${ev.name} 全文拉取失败（可能已被压缩摘要），查看器仅 4KB 截断版`)
              }
            })
          }
          setActive((a) => {
            const tools = [...a.tools]
            const idx = tools.findIndex((t) => t.status === 'running' && t.name === ev.name)
            const use = ev.use as ToolUseBlock | undefined
            const done = {
              name: ev.name,
              use,
              result: { type: 'tool_result' as const, tool_use_id: ev.itemId, content: ev.content, is_error: ev.isError },
              status: (ev.isError ? 'error' : 'done') as 'error' | 'done',
            }
            if (idx >= 0) tools[idx] = done
            else tools.push(done)
            return { ...a, tools }
          })
          setActivity({ state: 'thinking' })
          break
        }
        case 'usage':
          recordUsage(ev.input, ev.output, { read: ev.cacheRead, creation: ev.cacheCreation })
          break
        case 'thread/status':
          runningRef.current = ev.busy
          setRunning(ev.busy)
          setIter(ev.iter)
          if (ev.maxIter !== undefined) setMaxIter(ev.maxIter)
          break
        case 'activity':
          setActivity({ state: ev.state as ActivityState, text: ev.text })
          break
        case 'turn/completed':
          messagesRef.current = [...host.transcript]
          setActivity((cur) => (cur.state === 'aborted' ? cur : { state: 'idle' }))
          // M14-V4（§3.3 查因后拍板方案一）：轮末即 commit——本轮 transcript 在 completed 时已
          // 终局（afterTools 是轮间回喂、跨 turn 通知是下轮注入，无漏消息风险），全量送 Static
          // 后动态区清零（空闲态只剩输入+状态栏，永不超限——轮末 markdown 滞留是最大溢出源）。
          // M2 的延迟 commit（下次 submit 才收）是「留动态区可 Ctrl+O 展开」的交互决策；
          // Static 的工具组本就展开（M3 §7.5），滚轮回看语义更优。error 轮无 completed 帧，
          // submit 开头的兑现兜底保留
          if (host.transcript.length > 0) {
            setCommitted(messagesToCommitted([...host.transcript]))
            setActive(createActive())
          } else {
            setActive((a) => ({ ...a, streaming: false }))
          }
          break
        case 'warn':
          pushNoticeFn('warn', ev.text)
          break
        case 'notice':
          pushNoticeFn(ev.level, ev.text)
          break
        case 'systemMsg':
          setSystemMsgs([ev.text])
          break
        case 'error':
          setActive((a) => ({ ...a, streaming: false }))
          setError(toAppError(new Error(ev.message)))
          setActivity({ state: 'idle' })
          break
        case 'compacted':
          messagesRef.current = [...host.transcript]
          setCommitted(messagesToCommitted([...host.transcript]))
          setSystemMsgs(['✓ 已压缩对话（旧消息已摘要进上下文，原文仍显示）'])
          break
        case 'compacting':
          setSystemMsgs(['正在压缩对话...'])
          break
        case 'compactFailed':
          setSystemMsgs(['（压缩未完成——对话太短或摘要失败，稍后自动重试）'])
          break
        case 'approval/requested': {
          confirmRef.current = true
          // 批2b ④：审批出现即未选择态（draft 状态机重置；Enter 不静默批准）
          // 批2d（§13.1 拍板-1 附）：审批卡首次出现响一次 BEL 终端铃（同一审批不重复——
          // resolved 后弹窗清空，响过的 requestId 留痕即可防重放/连续 requested 重响）
          if (configRef.current.bellOnApproval !== false && !bellRungRef.current.has(ev.requestId)) {
            bellRungRef.current.add(ev.requestId)
            process.stdout.write(BEL_CHAR)
          }
          const remember = ev.decisions.includes('always')
          setActive((a) => ({
            ...a,
            confirm: {
              use: { type: 'tool_use', id: ev.requestId, name: ev.tool, input: {} },
              preview: ev.preview,
              ...(remember
                ? {
                    rememberLabel:
                      ev.kind === 'mcp-permission'
                        ? '永久记住（写入 settings.local.json）'
                        : // F-07 档A：内置 edit/write 的会话级工具放行（与 MCP server 级放行区分文案）
                          ev.tool.startsWith('mcp__')
                          ? '本会话记住此 MCP server 的工具'
                          : '本会话记住此工具',
                  }
                : {}),
              resolve: (ok: boolean, always?: boolean, reason?: string) => {
                confirmRef.current = false
                // 审阅 P1-1(b)：本端应答即清主输入框草稿（卡语义终点——用户在卡上打的字
                // 是给审批的，不应答后残留成下一张卡的 hasDraft 基线/被 Enter 误提交）
                clearMainDraft()
                void host.send({
                  op: 'approval/respond',
                  requestId: ev.requestId,
                  decision: ok ? (always === true ? 'always' : 'once') : 'reject',
                  ...(ok !== true && reason !== undefined && reason !== '' ? { message: reason } : {}),
                })
              },
            },
          }))
          break
        }
        case 'approval/resolved':
          confirmRef.current = false
          // 审阅 P1-1(b)：另一端应答同样清草稿（卡消失是语义终点，双端一致）
          clearMainDraft()
          setActive((a) => (a.confirm !== null && a.confirm !== undefined ? { ...a, confirm: null } : a))
          break
        case 'approval/claimed':
          // M14-C2⑤（D12 advisory）：另一端认领审批——TUI 不撤弹窗（先答先得权威不变），告警中心留痕供扫一眼
          pushNoticeFn('info', `审批已由「${ev.claimant}」端认领处理中（仍可在本端作答）`)
          break
        case 'askUser/requested':
          pickerRef.current = true
          setOverlay({
            kind: 'question-panel',
            questions: ev.questions as AskUserQuestion[],
            resolve: (r) => {
              pickerRef.current = false
              setOverlay(null)
              void host.send({ op: 'askUser/respond', requestId: ev.requestId, answers: r })
            },
          })
          break
        case 'subagent/progress':
          setSubagents(ev.agents as SubagentStatus[])
          break
        case 'queue/snapshot':
          setInterjectPreview(ev.items.length > 0 ? ev.items.join(' / ') : null)
          break
        case 'interjection/injected':
          setInterjectPreview(null)
          break
        default:
          break // 其余事件 B5 消费或无需 UI
      }
    })
    return () => {
      unsub()
      host.dispose()
      hostRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（host/recordUsage/pushNoticeFn 均稳定引用或 ref 闭包）
  }, [])

  const doSubmit = async (input: string, display?: string, blocks?: ContentBlock[]): Promise<void> => {
    // —— 客户端预处理：图片载荷（路径引用；块组装在宿主 buildBlocks）——
    let images: { path: string; mime: string; label?: string }[] | undefined
    if (blocks !== undefined) {
      const imgs = blocks.filter((b): b is ImageBlock => b.type === 'image' && '_path' in b)
      if (imgs.length > 0) images = imgs.map((b) => ({ path: (b as ImageBlock & { _path: string })._path, mime: '' }))
    }
    // M10-P2b 零键位：提交文本恰好是图片路径 → 图片输入（display 保持原文）
    if (images === undefined && display === undefined && /^\s\n[^\n]+\.(png|jpe?g|webp|gif)\s$/i.test(input)) {
      images = [{ path: input.trim(), mime: '' }]
      input = `${input.trim()}（已作为图片输入）`
    }
    // 粘贴标签引用：文本里引用了 [图片#N] 的才发送（删标签=删图，两家同款剪枝）
    if (images === undefined && pendingImagesRef.current.length > 0) {
      const referenced = [...input.matchAll(/\[图片#(\d+)\]/g)].map((m) => Number(m[1]))
      const refs = pendingImagesRef.current.filter((_, i) => referenced.includes(i + 1))
      if (refs.length > 0) images = refs.map((img) => ({ path: img.path, mime: '' }))
    }
    // 忙碌态：插话（hook 拦截/附加上下文在 enqueueInterject 客户端侧）
    if (runningRef.current) {
      await enqueueInterject(input, images)
      return
    }
    // 配置无效态
    if (!config.providers[config.current.name]) {
      setBanner('配置不完整，输入 /setup 配置')
      return
    }
    // error 轮兜底 commit（正常轮在 turn/completed 已进 Static——V4；error 轮无 completed 帧，
    // transcript 里的本轮内容在这里收进 Static 再开新轮）
    if (host.transcript.length > 0) {
      setCommitted(messagesToCommitted([...host.transcript]))
    }
    // SessionStart additionalContext（客户端持有状态）随首轮注入
    if (pendingSessionCtxRef.current.length > 0) {
      input = `${input}\n\n[hook context]\n${pendingSessionCtxRef.current.join('\n')}`
      pendingSessionCtxRef.current = []
    }
    // 消息确认发送：粘贴暂存此刻清空（早退路径均不清——图片不丢）
    pendingImagesRef.current = []
    setPendingImages([])
    setActive({ ...createActive(), userInput: display ?? input, streaming: true })
    setError(null)
    setActivity({ state: 'thinking' })
    const r = await host.send({
      op: 'prompt',
      text: input,
      mode: 'StartOrSteer',
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    })
    if (!r.ok) {
      setActive((a) => ({ ...a, streaming: false }))
      setSystemMsgs([`发送失败：${r.error}`])
      setActivity({ state: 'idle' })
    }
  }

  // P1 闪退面：doSubmit 前半段（图片组装/hook dispatch/getByType 等）在内部 try 之外，任一
  // reject → void submit(...) 成 unhandledRejection → cli 顶层 handler exit(1) 杀掉整个 TUI。
  // 包装层整体兜底（含 runningRef 复位——hook dispatch 抛出时已置 true，不复位则 TUI 永久 busy）。
  const submit = async (input: string, display?: string, blocks?: ContentBlock[]): Promise<void> => {
    // 提交即清草稿镜像（P1-1 补丁：InputStream submit 内部清框的 onDraftChange('') 传播
    // 在重负载下可能滞后于下一张审批卡出现——hasDraft 假阳性会让 y/n/r 让位进草稿。此处
    // 显式同步，镜像以「提交必然清空」为不变量）
    setMainDraft('')
    try {
      await doSubmit(input, display, blocks)
    } catch (e) {
      runningRef.current = false
      setActivity({ state: 'idle' })
      deps.logger.error('tui', 'submit_failed', { message: e instanceof Error ? e.message : String(e) })
      setSystemMsgs(['提交失败：' + (e instanceof Error ? e.message : String(e))])
    }
  }

  // 清 confirm（ConfirmPrompt 内先 resolve 再调它）
  const clearConfirm = () => {
    confirmRef.current = false
    // 审阅 P1-1(b)：应答即清草稿镜像（与 resolve/approval/resolved 三点同步）
    clearMainDraft()
    setActive((a) => ({ ...a, confirm: null }))
  }

  // 批2b ①：审批卡按键转发——草稿权威在主输入框（审阅 P1-1 方案 B）：字符/退格经 insert
  // 通道写入输入框（可见渲染；TextInput 在审批期 inactive 只不接键，渲染不受影响），Enter
  // 提交当前输入框内容走插话通道（审批期 loop 挂起即 running=true，submit 自然入队）；
  // 应答后 cur 保留 = 字还在可继续编辑（clearMainDraft 只在应答时清）
  const handleConfirmDraftKey = (inputChar: string, key: { return?: boolean; backspace?: boolean; delete?: boolean }): void => {
    if (key.return) {
      const text = readMainDraft()
      if (text.trim() === '') return
      setInputDraft({ text: '', seq: nextInsertSeq() })
      void submit(text) // 审批期 running=true → enqueueInterject（排队「后面的都拒绝」等指令）
      return
    }
    if (key.backspace) {
      setInputDraft({ text: readMainDraft().slice(0, -1), seq: nextInsertSeq() })
      return
    }
    // Delete 前向删除忽略：审批期光标恒在输入框末尾（insert 通道整串覆写语义），
    // 前向删除无目标字符——等价 no-op（P2-5 明示）
    if (key.delete || inputChar === '') return
    setInputDraft({ text: readMainDraft() + inputChar.replace(/\r\n?/g, '\n'), seq: nextInsertSeq() })
  }

  // 清动态/瞬态状态（onClear 和 restoreSession 共用；committed 由调用方设，§9.2 P2-6 别重写一套）
  const resetTransient = () => {
    // M7 H-P5：skill hooks 是会话级——起新会话（/clear、恢复历史）即注销全部
    // M13-W1：经项目级端口（多项目不串台）；缺省走模块兜底
    ;(deps.skillHooks ?? globalSkillHooks).unregisterAll()
    // 兜底：若有挂起的 confirm（inactive 本应挡住命令触发，此处 defense-in-depth），取消避免 Promise 永挂
    if (active.confirm) {
      active.confirm.resolve(false)
      confirmRef.current = false
    }
    setActive(createActive())
    setSystemMsgs([])
    pendingImagesRef.current = [] // M10 修复批：换会话不带旧会话的待发送附件
    setPendingImages([])
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

  /** 蒸馏预览确认（复用 active.confirm 通道；合成 use 走 ConfirmPrompt 默认渲染分支）。
 * B3：审批已走宿主 Broker，此纯客户端确认直写单槽（与本客户端并发概率低；confirmRef 同步中断判定） */
  const askPreviewConfirm = (preview: string, what: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      confirmRef.current = true
      setActive((a) => ({
        ...a,
        confirm: {
          use: { type: 'tool_use', id: `skill-create-${Date.now()}`, name: what, input: {} },
          preview,
          resolve: (ok: boolean) => {
            confirmRef.current = false
            resolve(ok)
          },
        },
      }))
    })

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

  /** M5：手动 /compact——宿主执行强制压缩（boundary 追加宿主 messages）+ 镜像同步 + 重建 committed */
  const compactManual = async (): Promise<void> => {
    if (host.transcript.length === 0) {
      setSystemMsgs(['（无可压缩对话）'])
      return
    }
    if (!config.providers[config.current.name]) return
    setSystemMsgs(['正在压缩对话...'])
    try {
      const r = await host.compactManual()
      messagesRef.current = [...host.transcript]
      setCommitted(messagesToCommitted([...host.transcript]))
      setSystemMsgs([r.ok ? '✓ 已压缩对话（旧消息已摘要进上下文，原文仍显示）' : `（压缩未完成——${r.reason ?? '对话太短或摘要失败'}）`])
    } catch (e) {
      setSystemMsgs([`压缩异常：${e instanceof Error ? e.message : String(e)}`])
    }
  }

  /** M5：切换 model 后检测 context 是否超新窗口（只提示风险，不自动压缩；用户主动 /compact） */
  const checkModelWindow = async (model: string, providerName: string): Promise<void> => {
    // P1：整体兜底——resolveContextWindow 联网查 models.dev 可能 reject，而调用点是
    // void checkModelWindow(...)，不兜会成 unhandledRejection 杀 TUI（与 submit 同款闪退面）
    try {
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
    } catch (e) {
      // 失败保持旧窗口缓存（默认 200k 兜底），不刷 banner 不影响流程
      deps.logger.warn('tui', 'check_model_window_failed', { message: e instanceof Error ? e.message : String(e) })
    }
  }

  const restoreSession = async (sessionId: string) => {
    // M14-C5①：载入经 ProjectHost.ensureRestore（与 web/飞书 session/restore 命令同一条载入
    // 路径——损坏降级空会话/并发单飞/活复用单源化）；TUI 保持 fork 续写语义（灌当前 host +
    // 起新 id）。测试 fake 无 project 走直调兜底（与 M12 等价）
    const messages =
      deps.project !== undefined
        ? [...(await deps.project.ensureRestore(sessionId)).transcript]
        : deps.history.restoreFull(sessionId)
    // P1-10：restore 返回空（文件缺失/损坏/真空会话）→ 保留当前会话 + 提示，不静默清空
    if (messages.length === 0) {
      setSystemMsgs(['⚠ 恢复失败：该会话为空或已损坏（文件缺失/无消息），未切换'])
      return
    }
    host.restoreFrom(messages)
    messagesRef.current = [...host.transcript]
    setCommitted(messagesToCommitted(messages))
    resetTransient()
    // 续写进新文件（起新 sessionId）；model 用当前 config（用户可能已 /model 切过）
    const newId = new Date().toISOString().replace(/[:.]/g, '-')
    // M9-P2：快照目录拷贝跟随（起新 id 后旧快照仍可用——否则「跨重启可回退」落空，CC copyFileHistoryForResume 同款）
    const oldId = deps.history.currentSessionId()
    // D2 补全：恢复行全量播种进新文件（fork 自包含——重开不丢前文；loop.ts 只增量 append 不双写）
    deps.history.forkSession(newId, messages, config.current.model)
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
  // CLI `ecode --history <id>` 启动恢复：复用 /history 的 restoreSession（起新 sessionId 续写，D2）。
  // host 由 hostRef 渲染期惰性构造，effect 执行时已就绪；restoreSession 每渲染重建不列依赖，
  // prop 为启动期常量——仅随它触发一次。
  useEffect(() => {
    if (initialHistorySessionId !== undefined) void restoreSession(initialHistorySessionId)
  }, [initialHistorySessionId])

  const { warning } = useInterrupt({
    onInterrupt: () => {
      // 本地 abort（hook 子进程中断）+ 宿主 interrupt（loop 的 signal 在宿主）
      abortRef.current.abort()
      void host.send({ op: 'interrupt' })
    },
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

  // 界面批 B1：Ctrl+E 单工具级展开——在「未展开的工具」中循环展开下一个（再按展开下一个；
  // 全展开后按=全收起重置）。与 Ctrl+O（组级全开/全收）互补：多工具轮里"看刚执行的这一个"。
  // 展开行数仍入 V2 预算（ToolGroupView expandCap + Conversation 展开态 maxTools=min(cap,1) 钳制）
  const expandNextTool = () => {
    setActive((a) => ({ ...a, expandedTools: nextSingleExpand(a.tools, a.expandedTools) }))
  }

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'o') toggleExpand()
      if (key.ctrl && input === 'e') expandNextTool()
    },
    // P2-4：overlay/confirm 期间不抢 Ctrl+O/Ctrl+E（picker/confirm 独占输入）
    { isActive: overlay === null && active.confirm === null },
  )

  // 界面批 C3：空闲态双击 Esc（间隔 <500ms）直达 /rewind 面板（CC 双击 Esc 零成本入口对位）。
  // Esc 三态语义不破坏：面板开=关面板（overlay!==null 时不激活本 handler）、回填态=清空
  // （InputStream slash 回填 Esc 自处理——本 handler 只在空闲态激活）、审批卡=拒绝（confirm
  // 非 null 时不激活）。守卫：busy 不接管（运行中 rewind 有竞态）、checkpoint 未启用不响应
  // 清账 III P2-1：@ 下拉开着与否的同步读（主输入框 atEntries 状态在 InputStream 内——
  // 经 draft 端口同族的轻量探测：无端口代理时退化为 false）
  const atEntriesOpenRef = useRef(false)
  const lastEscRef = useRef(0)
  // 清账 III P2-1：双击计时排除「输入框非空或 @ 下拉开着」态——用户关下拉/清回填的连击
  // 不应误开 rewind（第一次 Esc 已被消费，第二次是另一意图）
  const escGuarded = readMainDraft() !== '' || atEntriesOpenRef.current
  useInput(
    (_input, key) => {
      if (!key.escape) return
      const now = Date.now()
      if (!escGuarded && now - lastEscRef.current < 500 && deps.checkpoint != null) {
        lastEscRef.current = 0
        pickerRef.current = true
        setOverlay({ kind: 'rewind-panel' })
        return
      }
      lastEscRef.current = escGuarded ? 0 : now
    },
    { isActive: overlay === null && active.confirm === null && !running },
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

  // placeholder 判据改运行态镜像（streamingText 延迟 commit 常驻的旧病根治）
  const busy = running

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
      conditions={{ tasksBar: tasksActive, subagentBar: subagents.length > 0 }}
      model={config.current.model}
      banner={banner}
      committed={fullCommitted}
      active={active}
      onToggleTool={hasDoneTool ? toggleExpand : undefined}
      onConfirm={clearConfirm}
      onCancel={clearConfirm}
      onDraftKey={handleConfirmDraftKey}
      draft={mainDraft}
      readDraft={() => draftPortRef.current?.read() ?? ''}
      activity={activity.state}
      activityText={activity.text}
      running={running}
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
      <TasksBar />
      {interjectPreview !== null && (
        <Box paddingLeft={1}>
          <Text dimColor>
            已排队：{interjectPreview.slice(0, 40)}（Ctrl+U 清空）
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
            void restoreSession(sid)
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
            setInputDraft({ text: fill, seq: nextInsertSeq() })
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
      {overlay?.kind === 'output-panel' && (
        <OutputListPage
          recentTools={recentTools}
          onOpen={(entry: OutputEntry) => {
            const cols = process.stdout.columns ?? 80
            const width = Math.max(10, cols - 4)
            if (entry.kind === 'tool') {
              setOverlay({
                kind: 'output-view',
                title: `${entry.tool.name}（${entry.tool.itemId}）${entry.tool.truncated === true ? ' 〔截断，补全中〕' : ''}`,
                source: toolResultSource(() => recentToolsRef.current.find((t) => t.itemId === entry.tool.itemId), width),
              })
            } else if (entry.kind === 'task') {
              const snap = taskRegistry.snapshot().find((t) => t.id === entry.id)
              setOverlay({
                kind: 'output-view',
                title: `task ${entry.id}：${snap?.command.slice(0, 50) ?? ''}（${snap?.status ?? '?'}）`,
                source: taskFileSource(entry.id, width),
              })
            } else {
              setOverlay({ kind: 'output-view', title: `子代理 ${entry.id} transcript`, source: subagentSource(entry.id, width) })
            }
          }}
          onExit={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'output-view' && (
        <OutputViewer title={overlay.title} source={overlay.source} onBack={() => setOverlay({ kind: 'output-panel' })} />
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
            host.appendRewind(line) // 宿主权威（审阅 P0-3：只写客户端镜像时回退不进 LLM 上下文）
            messagesRef.current = [...host.transcript]
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
          void host.send({ op: 'interjection/clear' })
        }}
        busy={runningRef.current}
        onSlashBusy={() => setSystemMsgs(['运行中暂不能执行命令（空闲后再发；插话请直接输入文字）'])}
        onTabSandbox={() => {
          // 清账 III P1-2 配套：忙碌守卫在宿主（sandbox/set BUSY 拒）——TUI 侧同样拦下并提示，
          // 避免 full-access 提档弹审批帧后又被宿主拒绝的双跳
          if (runningRef.current) {
            setSystemMsgs(['运行中不能切换沙箱档位——空闲后再按 Tab'])
            return
          }
          // M12-B3（审阅 P0-2 修复）：档位权威在宿主（sandbox/set）；full-access 提档经宿主 Broker 审批帧确认
          const next = nextSandboxMode(sandboxModeRef.current)
          if (next === 'full-access') {
            pickerRef.current = true
            void host.send({ op: 'sandbox/set', mode: 'full-access' }).then((r) => {
              pickerRef.current = false
              if (r.ok) {
                applySandboxMode('full-access')
                setSystemMsgs(['沙箱模式：full-access（本会话副作用免确认）'])
              } else {
                setSystemMsgs([`提档未生效：${r.error}`])
              }
            })
            return
          }
          applySandboxMode(next)
          void host.send({ op: 'sandbox/set', mode: next })
          setSystemMsgs([`沙箱模式：${next}${next === 'default' ? '（写/bash 每次确认）' : ''}`])
        }}
        onSkillInvoke={(name, args) => {
          // S4.4 手动触发：展开全文作 userInput，原始 `/name args` 作 display
          const info = deps.skillRegistry.get(name)
          if (info === undefined) return
          // M7 H-P5：skill 附带 hooks → 会话级注册 + 底部告知（与 LLM 面同语义）
          if (info.hooks !== undefined && info.hooks.length > 0) {
            ;(deps.skillHooks ?? globalSkillHooks).register(info.name, info.hooks)
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
            setHistoryMetas(deps.history.loadAll(process.cwd()))
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
          if (result.action === 'open-output-panel') {
            pickerRef.current = true
            setOverlay({ kind: 'output-panel' })
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
          // B5：宿主权威 messages 同步清（session/clear）；客户端镜像与瞬态 UI 本地重置
          void host.send({ op: 'session/clear' })
          messagesRef.current = []
          setCommitted([])
          resetTransient()
        }}
        // M11-P7：忙碌态保持激活（插话 Enter 入队；overlay/confirm 仍独占）
        // 批2b ①：confirm 期仍 inactive（字符由 ConfirmPrompt→onDraftKey 通道兑现——
        // 避免 TextInput 与审批卡双吃按键）；确认/取消语义在 ConfirmPrompt 内
        inactive={overlay !== null || active.confirm !== null}
        insert={insert}
        onRegisterDraft={registerPort}
        onDraftChange={setMainDraft}
        onRegisterAtOpen={(port) => {
          atEntriesOpenRef.current = port !== null
        }}
        placeholder={
          active.confirm !== null
            ? '（审批中…打字进草稿，y/n/Esc 应答）'
            : busy
              ? '（处理中，Ctrl+C 中断）...'
              : '输入消息，/help 查看命令...'
        }
      />
    </App>
  )
}
