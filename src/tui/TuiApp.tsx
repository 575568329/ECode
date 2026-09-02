import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { deriveLatestTodos, TodoPanel, TODO_MAX_VISIBLE } from './TodoPanel.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput, Text, Box } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { formatPasteRef, shouldTokenize, expandPasteRefs, prunePasteRefs } from './pasteRefs.js'
import { HostSession, isValidSessionId } from '../host/session.js'
import type { ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, ContentBlock, HistoryLine, ImageBlock, Message } from '../core/types.js'
import type { McpPanelView, RewindListResult } from '../protocol/types.js'
import type { CheckpointMeta } from '../services/checkpoint.js'
import { tokensToCost } from '../services/pricing.js'
import { buildContextMessages } from '../core/context.js'
import { resolveContextWindow } from '../services/contextWindow.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { resurrectDaemonReg, readServerReg } from '../cli/daemon.js' // tui→cli 反向单点（daemon 拉起逻辑归口；无循环依赖——daemon.ts 不 import tui）
import { createActive, liveTextOf, toolsOf, type CommittedItem, type ActiveState } from './types.js'
import { timelineReducer, makeTimelineIdFactory } from '../protocol/timeline.js'
import { messagesToCommitted } from './commit.js'
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
import { DevicesPanel } from './DevicesPanel.js'
import { RewindPanel } from './RewindPanel.js'
import { SandboxPanel } from './SandboxPanel.js'
import { ConfigPanel, type ConfigItem } from './ConfigPanel.js'
import { saveConfigKey } from '../services/configFs.js'
import { nextSandboxMode, SANDBOX_MODES, type SandboxMode } from '../services/sandbox.js'
import type { SubagentStatus } from '../services/subagent.js'
import { SubagentBar } from './SubagentBar.js'
import { TasksBar } from './TasksBar.js'
import { OutputListPage, OutputViewer, panelWidth, toolResultSource, taskFileSource, subagentSource, timelineSource, type OutputEntry, type RecentTool } from './OutputViewer.js'
import { taskRegistry } from '../services/tasks.js'
import { undoEcodeCommit } from '../services/git.js'
import { readClipboardImage } from '../services/clipboard.js'
import { pushNotice, deriveNoticeLine, renderNoticeLine, NOTICE_TTL_MS, type NoticeItem, type NoticeLevel } from './notices.js'
import { theme } from './theme.js'
import { enterAltScreen, exitAltScreen, AltScreen } from './AltScreen.js'
import { createAnsiStripper } from './sanitize.js'
import { allocateDynamic, useViewport } from './viewport.js'
import type { ReactNode } from 'react'
import type { AskUserQuestion, AskUserResult } from '../tools/builtin/ask_user.js'
import { Select } from './Select.js'
import type { McpManager } from '../services/mcp/manager.js'
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

/** F-48 批 2 降级链（审阅 P0-4 修正）：显式禁用 / tmux control-mode（CC 同款判定）→
 *  不写 1049 序列，altActive 恒 false——面板树走嵌入式分支（功能可用观感降级）。
 *  模块级读一次：此前的局部判定只盖了 enterAltScreen 一处，altActive 渲染口径没跟，
 *  <AltScreen/> 照样挂载补写 ENTER，降级整体失效。 */
const NO_ALT_SCREEN =
  process.env.ECODE_NO_ALT_SCREEN === '1' ||
  (process.env.TMUX !== undefined && process.env.TMUX.startsWith('/') === false)

/** 批2d（§13.1 拍板-1 附）：BEL 终端铃字符（审批卡首次出现时写一次，终端自行决定响/闪标题栏） */
const BEL_CHAR = '\x07'

/** 本进程 RSS 采样间隔（2026-09-02 内存可见性批）：5s 观测泄漏趋势足够，又不至于
 *  高频 setState 驱动整帧重算（TuiApp 组件树大，空闲态帧本应完全静止） */
const MEM_SAMPLE_MS = 5000

/** T 线 T4：形态无关的宿主客户端面——Embedded=HostSession 结构超集，附着=MultiTransport。
 *  TuiApp 只依赖此接口（mountBridges 可选：Embedded 宿主内部桥，附着形态 daemon 侧自挂）。 */
export interface TuiHost {
  send: (cmd: import('../protocol/types.js').ProtocolCommand) => Promise<import('../protocol/types.js').CommandResult>
  subscribe: (handler: (ev: import('../protocol/types.js').ProtocolEvent) => void, opts?: { canAnswer?: boolean }) => () => void
  dispose: () => void
  mountBridges?: () => void
  /** T5（D-T3 增补）：daemon 连接状态（顶栏「后台运行/连接中/重连中」标识；Embedded 无此面） */
  daemonState?: () => 'connecting' | 'open' | 'backoff'
}

export interface TuiAppDeps {
  providerRegistry: LLMProviderRegistry
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  config: Config
  orchestrator: CompactionOrchestrator
  /** T 线 T2：lastUsage 客户端本地化（usage 帧驱动——附着态 deps 对象在宿主进程不可直写） */
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
    // 默认沙箱档：启动即生效（宿主构造取它——daemon 重拉/新会话都回此档），会话内 Tab 临时切换不落盘
    { key: 'sandbox.defaultMode', label: 'sandbox.defaultMode（启动默认沙箱档）', value: config.sandbox?.defaultMode ?? 'default', options: [...SANDBOX_MODES], kind: 'enum' },
    // F-25（功能测试批）：文案对齐 M9 实际语义——空/缺省=关闭（不自动探测，防 npm-scripts RCE 链），改值走原始 config
    { key: 'lintCommand', label: 'lintCommand（空=关闭，改值开原始 config）', value: config.lintCommand ?? '', kind: 'readonly' },
  ]
}



/**
 * TuiApp：连接 AgentLoop 与 TUI（最小 Static 方案）。
 *
 * - committed：已固化的历史（进 <Static>，滚轮友好）
 * - active：当前轮活跃状态（分区累积：userInput / tools / streamingText）
 * - 提交即锁死：prompt 发送成功 → 用户消息全文 echo 进 Static（失败留动态区折叠显示）；
 *   轮末 commit：runLoop 结束 → messagesToCommitted 全量重建 → setCommitted；active 清空
 */
export function TuiApp({ deps, banner: initialBanner, initialNotice, onRestart, onExit, initialHistorySessionId, host: attachedHost, localFallback }: { deps: TuiAppDeps; banner?: string; /** 启动期一次性提示（如 daemon 附着成功）——走底部 systemMsgs 统一通道，5s TTL 自动消失；区别于 banner（配置错误持久横幅） */ initialNotice?: string; onRestart?: () => void; onExit?: () => void; initialHistorySessionId?: string; /** T 线 T4：附着形态由入口注入 MultiTransport（deps 换壳）；缺省=Embedded 内联装配 */ host?: TuiHost; /** 2026-09-02 TUI 稳定性拍板：daemon 重拉也失败时的本地兜底装配（惰性——降级发生才执行
 *  makeDeps 全装配；入参=当前 daemon 侧会话 id，降级后续写同一会话文件，TUI 不因后台失联断聊） */ localFallback?: (sessionId: string | undefined, config: Config) => TuiAppDeps }): ReactElement {
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

  // —— 输入体验批二期：粘贴 token 化（学 CC [Pasted text #N] 设计理念）——
  // 大块插入存内存 map，草稿里放短 token；提交时 expandPasteRefs 展开回全文，
  // 已发送的条目剪枝（删标签=删内容）。图片走 pendingImagesRef 同构机制。
  const pastedStoreRef = useRef(new Map<number, string>())
  const nextPasteIdRef = useRef(0)
  const handlePasteText = (text: string): string | null => {
    if (!shouldTokenize(text)) return null
    nextPasteIdRef.current += 1
    const id = nextPasteIdRef.current
    pastedStoreRef.current.set(id, text)
    return formatPasteRef(id, text)
  }
  const readMainDraft = (): string => draftPortRef.current?.read() ?? ''
  // M12-B3：插话预览由宿主 queue/snapshot 事件镜像（队列权威在宿主，D2）
  // 插话排队列表（queue/snapshot 全量同步 + injected 即时摘除）——对话区动态渲染留痕
  const [queuedInterjects, setQueuedInterjects] = useState<string[]>([])
  const enqueueInterject = async (text: string, images?: { path: string; mime: string; label?: string }[]): Promise<void> => {
    // T 线⑥（D-T5a）：插话 hook 宿主化——busy 输入经 prompt(StartOrSteer) 入队时宿主 dispatch
    // UserPromptSubmit（block 拒绝入队/context 注入），客户端不再二次 dispatch（原同进程捷径退役）
    const r = await host.send({ op: 'prompt', text, mode: 'StartOrSteer', ...(images !== undefined && images.length > 0 ? { images } : {}) })
    if (!r.ok) setSystemMsgs([`插话失败：${r.error}`], 'warn')
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
    const u = lastUsageRef.current
    u.input = inp
    u.output = out
    u.cacheRead = cache?.read ?? 0
    u.cacheCreation = cache?.creation ?? 0
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
  // T 线 T2：本轮 usage 缓存本地化（usage 帧驱动 recordUsage 写入——原 deps.lastUsage 退役）
  const lastUsageRef = useRef({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
  // T 线⑥：SessionStart additionalContext 暂存由宿主 pendingSessionContext 接管（原客户端 ref 退役）
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
    // 审阅 P2：附着态附件目录键控用 daemon 侧真实会话 id（原读本地壳 id——归档错位）
    const img = await readClipboardImage(attachedSidRef.current ?? deps.history.currentSessionId())
    if (img === null) {
      setSystemMsgs(['剪贴板无图片（或读取失败）'], 'warn')
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
  /** 档位权威在宿主（M12-B3）——拉宿主当前档对齐本地显示。失同步场景：daemon 失联重拉后
   *  HostSession 重建、档位静默回 config 默认，而本地 useState 仍显示用户切过的档——
   *  「显示 read-only 实际 default 全放行」的假安全；反向（TUI 重启附着活 daemon、宿主保留
   *  full-access 而本地显示 default）同病。embedded 形态宿主与 useState 同源构造，免拉。 */
  const syncSandboxFromHost = (): void => {
    const h = hostRef.current
    if (h === null) return
    void h
      .send({ op: 'sandbox/get' })
      .then((r) => {
        if (!r.ok) return
        const mode = (r.value as { mode?: unknown } | undefined)?.mode
        if (typeof mode === 'string' && SANDBOX_MODES.includes(mode as SandboxMode)) {
          applySandboxMode(mode as SandboxMode)
        }
      })
      .catch(() => {})
  }

  const [committed, setCommittedState] = useState<CommittedItem[]>([])
  // 提交即锁死：echo 组装下一态要读最新 committed（含 alt 冻结暂存值），ref 镜像随写随同步
  const committedRef = useRef<CommittedItem[]>([])
  // 提交即锁死：echo 项 id 序号（只求 React key 唯一，轮末重建会换回 transcript 位次 id）
  const echoSeqRef = useRef(0)
  // F-48 批 1：alt 面板期间的 committed 冻结——Static 组件「已渲染游标」存组件 state，
  // 面板打开期间新 commit 若直进 Static 会写进 alt buffer（退出后主 scrollback 缺行）；
  // 冻结暂存到 pending，退出面板（closeOutputPanel）后一次性补齐。altActiveRef 与
  // enterAltScreen/exitAltScreen 的序列标志分立：前者管数据冻结，后者管转义序列。
  const altActiveRef = useRef(false)
  const pendingCommittedRef = useRef<CommittedItem[] | null>(null)
  const setCommitted = (items: CommittedItem[]): void => {
    committedRef.current = items
    if (altActiveRef.current) {
      pendingCommittedRef.current = items
      return
    }
    setCommittedState(items)
  }
  /** alt 全屏 teardown 三件套（审阅 P0-3）：转义序列写 + 数据冻结解除 + 暂存 commit 补齐。
   *  审批/askUser 强制退面板与 Ctrl+T 关闭（closeOutputPanel）共用——此前审批路径只
   *  setOverlay(null)，altActiveRef 卡死后 setCommitted 永久进暂存，主对话静默停更 */
  const teardownAltFrame = (): void => {
    // 同步写 1049l 先于 React 提交（AltScreen 卸载 cleanup 的晚写兜底因此跳过——时序铁律）
    exitAltScreen()
    altActiveRef.current = false
    if (pendingCommittedRef.current !== null) {
      setCommittedState(pendingCommittedRef.current)
      pendingCommittedRef.current = null
    }
  }
  const closeOutputPanel = (): void => {
    teardownAltFrame()
    setOverlay(null)
  }
  const [active, setActive] = useState<ActiveState>(() => createActive())
  // 项 1（审阅挂账）：流式文本的净化器——转义序列可能被 delta 切成两半，stripper 跨块
  // 扣留半截序列；新轮 submit 时重置。净化后的文本仅作 UI 显示（transcript 原文不动，
  // Static 固化另有 commit.ts strip 兜底）
  const streamStripperRef = useRef(createAnsiStripper())
  // 活动流 B4：时间线归约依赖（id 工厂 ref——reducer 无内部状态，调用侧持有计数器）
  const tlDepsRef = useRef(makeTimelineIdFactory())
  // G+：delta 16ms 合帧缓冲（timer unmount 清理见 effect）
  const deltaBufRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null })
  // 活动流 B4：轮开始时间（loading 行轮内耗时——busy 翻转记录）
  const turnStartedAtRef = useRef<number | null>(null)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
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
  // F-38：TTL 过期时钟——仅当存在可过期条目（info/warn）时每秒 tick 驱动重渲染，
  // 到期条目从底部行退场（error 常驻不需要时钟；无过期条目时不挂 interval 不空转）
  const [noticeTick, setNoticeTick] = useState(() => Date.now())
  useEffect(() => {
    if (!notices.some((n) => NOTICE_TTL_MS[n.level] !== undefined)) return
    const timer = setInterval(() => setNoticeTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [notices])
  const [tokens, setTokens] = useState(0)
  // 2026-09-02 用户点名：本进程 RSS 常驻状态栏（孤儿实例堆积 4.8GB 事故后的内存可见性）。
  // 5s 采样——观测泄漏趋势足够，避免高频 setState 整帧重算；口径是 TUI 进程自身
  // （客户端进程），宿主/子代理内存不在此段
  const [memBytes, setMemBytes] = useState(() => process.memoryUsage().rss)
  useEffect(() => {
    const timer = setInterval(() => setMemBytes(process.memoryUsage().rss), MEM_SAMPLE_MS)
    return () => clearInterval(timer)
  }, [])
  const [sessionCost, setSessionCost] = useState(0)
  // F-44：上下文占用/窗口（usage 帧 API 真值：占用=本轮 prompt 全量 input+cacheRead；
  // 窗口=宿主 resolveContextWindow 解析缓存）——StatusBar ctx 段显示占用与余量
  const [ctxUsed, setCtxUsed] = useState<number | undefined>(undefined)
  // ctxUsed 的镜像 ref（checkModelWindow 等闭包读最新值免依赖数组）
  const lastCtxUsedRef = useRef<number | undefined>(undefined)
  const [ctxWindow, setCtxWindow] = useState<number | undefined>(undefined)
  // F-38：即时系统提示（命令反馈/状态提示）——保留输入框上方多行渲染（/cost 等命令输出
  // 需要完整多行，塞底部行会被截断），但加两点秩序：①TTL 5s 自动消失（不再常驻占屏）；
  // ②分级着色（默认 dim，失败类调用点传 'warn' 黄色）——错误类型有秩序。
  const [systemMsgs, setSystemMsgsState] = useState<Array<{ text: string; level: NoticeLevel }>>([])
  const setSystemMsgs = (msgs: string[], level: NoticeLevel = 'info'): void => {
    setSystemMsgsState(msgs.length === 0 ? [] : msgs.map((text) => ({ text, level })))
  }
  // TTL 时钟：新消息重置计时（依赖数组挂 systemMsgs 引用）；空队列不挂 timer 不空转
  useEffect(() => {
    if (systemMsgs.length === 0) return
    const timer = setTimeout(() => setSystemMsgsState([]), 5000)
    return () => clearTimeout(timer)
  }, [systemMsgs])
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
  // F-47：overlay 联合提取命名——setOverlay 包装函数（pickerRef 收口）参数类型引用
  type OverlayState =
    | { kind: 'model-picker' }
    | { kind: 'pick-history' }
    | { kind: 'setup-wizard' }
    | { kind: 'skill-panel' }
    | { kind: 'mcp-panel' }
    | { kind: 'plugin-panel' }
    | { kind: 'warnings-panel' }
    | { kind: 'devices-panel' }
    | { kind: 'rewind-panel' }
    | { kind: 'sandbox-panel' }
    | { kind: 'config-panel' }
    | { kind: 'output-panel' }
    // backToList（输入体验批 Ctrl+C 矩阵探针抓出）：视图层 Esc/q/Ctrl+C 的 onBack 语义按入口
    // 分流——/output 列表进入=回列表；Ctrl+T 直达（缺省 false）=关闭整面板回主界面。
    // 旧实现一律回列表，Ctrl+T 用户按 Ctrl+C 落在列表页再被「输入即搜索」吞键=按键黑洞
    | { kind: 'output-view'; source: import('./OutputViewer.js').LineSource; title: string; backToList?: boolean }
    | { kind: 'select'; title: string; options: string[]; resolve: (v: string | undefined) => void }
    // M8 ask_user：工具发起的提问面板（Promise 桥——resolve 回工具 execute）
    | { kind: 'question-panel'; questions: AskUserQuestion[]; resolve: (r: AskUserResult) => void }
  const [overlay, setOverlayState] = useState<OverlayState | null>(null)
  // F-47 批 0：overlay 开关收口——pickerRef 随开随关。此前 output 系关闭路径（onExit/
  // onBack）不复位 pickerRef，用过一次 /output 后 useInterrupt.isActive 永真 → Ctrl+C
  // 中断/双击退出永久哑火（审阅 P0-6 实证）。setOverlay 包装后 20+ 调用点零改动；
  // 残留的手动 pickerRef 赋值与包装幂等。
  const overlayRef = useRef<OverlayState | null>(null)
  const setOverlay = (o: OverlayState | null | ((cur: OverlayState | null) => OverlayState | null)): void => {
    const next = typeof o === 'function' ? o(overlayRef.current) : o
    overlayRef.current = next
    pickerRef.current = next !== null
    setOverlayState(next)
  }
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
  // 启动期一次性提示（daemon 附着成功等）：挂载后经 systemMsgs 底部统一通道展示（5s TTL）
  const initialNoticeShownRef = useRef(false)
  useEffect(() => {
    if (initialNotice === undefined || initialNoticeShownRef.current) return
    initialNoticeShownRef.current = true
    setSystemMsgs([initialNotice])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（仅消费启动期常量）
  }, [])
  // /plugin 面板刷新 key（安装/启停操作后重查 browse/list——数据是 loader 现查的，靠 remount 重建）
  const [pluginPanelKey, setPluginPanelKey] = useState(0)
  // /restart 句柄经 ref（deps 闭包稳定，setTimeout 回调取最新）
  const onRestartRef = useRef(onRestart)

  // —— M12-B3：宿主会话（数据/执行/审批全权在宿主；TuiApp 只是协议客户端）——
  const hostRef = useRef<TuiHost | null>(null)
  /** 附着形态的 MultiTransport（setSessionId/reattach 用；embedded 下恒 null） */
  const transportRef = useRef<{ setSessionId?: (sid: string) => void; reattach?: (baseUrl: string, token: string) => void } | null>(null)
  if (attachedHost !== undefined && hostRef.current === null) {
    hostRef.current = attachedHost
    if ('setSessionId' in attachedHost) {
      transportRef.current = attachedHost as { setSessionId?: (sid: string) => void }
      // T5（P1-2 接线）：mux 重连 gap=true（重放缓冲覆盖不到）→ transcript 全量补拉自愈
      ;(attachedHost as { onReconnect?: (gap: boolean) => void }).onReconnect = (gap) => { if (gap) syncCommitted() }
      ;(attachedHost as { onUnauthorized?: () => void }).onUnauthorized = () => {
        setSystemMsgs(['⚠ 后台服务凭据失效——请重新认证或重启 daemon'], 'warn')
      }
    }
  }
  /** Embedded 宿主构造（初始兜底与 2026-09-02 自愈降级共用）：优先 ProjectHost（makeDeps
   *  装配形态——skills/hooks 等项目级件齐备），否则内联 HostSession（测试 fake 形态） */
  const buildInlineHost = (d: TuiAppDeps): HostSession => {
    if (d.project !== undefined) return d.project.ensureDefault(d.history.currentSessionId()) as HostSession
    const h = new HostSession({
      providerRegistry: d.providerRegistry,
      tools: d.tools,
      logger: d.logger,
      history: d.history,
      getConfig: () => configRef.current,
      orchestrator: d.orchestrator,
      skillListForPrompt: () => d.skillRegistry.listForPrompt(),
      ...(d.hookRunner != null ? { hookRunner: d.hookRunner } : {}),
      ...(d.checkpoint != null && d.checkpoint !== undefined ? { checkpoint: d.checkpoint } : {}),
      ...(d.quality != null && d.quality !== undefined ? { quality: d.quality } : {}),
      ctxWindowHint: () => ctxWindowRef.current,
      cwd: process.cwd(),
      // T 线 T2：session/restore 命令的 Embedded 端口——宿主即会话宿主，载入=restoreFrom
      // 自身（无 ProjectHost 间接）；历史由 d.history 真读（fake store 空会话返回 NOT_FOUND）。
      // 2026-09-02 用户拍板：恢复=**继续原会话**（同 id 续写，不再 fork 复制一份）——
      // 载入外还须切本地续写指针（restoreFrom 只换内存 messages，落盘仍按 history 的
      // currentId——不切则后续 prompt 全写进恢复前的旧会话文件）
      ensureConversation: (sid) => {
        if (!isValidSessionId(sid)) return Promise.resolve({ ok: false as const, error: `会话 id 非法：${sid}`, code: 'BAD_SESSION_ID' })
        const lines = d.history.restoreFull(sid)
        if (lines.length === 0) return Promise.resolve({ ok: false as const, error: '会话不存在或为空', code: 'SESSION_NOT_FOUND' })
        h.restoreFrom(lines)
        d.history.setSessionId(sid)
        return Promise.resolve({ ok: true as const, value: { sessionId: sid } })
      },
    })
    return h
  }
  if (hostRef.current === null) {
    // M13-W1：宿主取自 ProjectHost（会话容器；首会话已由 makeDeps ensure——此处幂等取回）；
    // 测试 fake 无 project 走内联构造兜底（与 M12 等价）
    // HostSession 结构超集兼容 TuiHost（附着形态同位替换为 MultiTransport）
    hostRef.current = buildInlineHost(deps)
  }
  const host = hostRef.current
  /** T 线 T4：附着态标记（挂账项守卫——skill-create/PluginPanel 等直调面附着态禁用，D-T2）。
   *  审阅 P2：派生加 transportRef——自愈降级置 null 后即回本地语义（/skill-create 等不再误报
   *  「附着模式不可用」）；重渲染时机由降级内的 setState 保证 */
  const attached = attachedHost !== undefined && transportRef.current !== null

  // T 线 T2：transcript 读面命令化——宿主 messages 镜像改走 session/read 无参全量（与
  // restoreFull 同源同形；Embedded=InMemoryChannel 内存拷贝，附着=HTTP）。原 12 处
  // `host.transcript` 直调的协议通道等价物；失败保留旧镜像（不闪空）
  const pullTranscript = async (): Promise<HistoryLine[]> => {
    // 2026-09-02 回归修复：附着态目标 id 取 attachedSidRef（daemon 侧真实会话）——原用本地
    // deps.history 的 id，daemon 上不存在该会话 → session/read 恒 SESSION_NOT_FOUND →
    // turn/completed 时 committed 永不增长，而动态区每轮清空 → 本轮 LLM 回复+工具调用
    // 全部丢屏（TUI 只剩用户提问 echo）。Embedded 退回本地 id（本地 history 即权威）
    const r = await host.send({ op: 'session/read', sessionId: attachedSidRef.current ?? deps.history.currentSessionId() })
    if (!r.ok) return messagesRef.current
    return r.value as unknown as HistoryLine[]
  }
  /** T 线 T4：附着态当前会话 id（prompt 回执/restore 回执记录；embedded 走 deps.history） */
  const attachedSidRef = useRef<string | undefined>(undefined)
  const recordSessionId = (sid: string): void => {
    attachedSidRef.current = sid
    transportRef.current?.setSessionId?.(sid)
  }
  /** 拉取并同步渲染镜像（ref+committed 全量重建——事件回调内异步化）。
   *  返回 Promise 供轮首兜底串行化（doSubmit await：兜底重建与 echo 追加交错会把
   *  transcript user 项+echo 项双双进 Static——同内容重复上屏，2026-09-02 实证）；事件
   *  回调调用点不 await，行为不变 */
  const syncCommitted = (lines?: HistoryLine[]): Promise<void> => {
    return (lines !== undefined ? Promise.resolve(lines) : pullTranscript()).then((l) => {
      messagesRef.current = l
      setCommitted(messagesToCommitted(l))
    }).catch(() => {})
  }
  /** 仅同步时间线/上下文读源 ref（不动 committed——动态区还在流式） */
  const syncRefOnly = (): void => {
    void pullTranscript().then((l) => { messagesRef.current = l }).catch(() => {})
  }

  // T 线 T2：rewind 协议适配器（RewindStore 窄接口的协议实现）——list 回执已带各点
  // externallyChanged 预计算，detectExternalChanges 直查缓存；revert 走 rewind/exec。
  // 原直调 CheckpointStore 真件的路径退役（附着态同构）。
  const rewindListCacheRef = useRef<RewindListResult | null>(null)
  const rewindProtocolStore = {
    list: async (_sessionId: string): Promise<CheckpointMeta[]> => {
      const r = await host.send({ op: 'rewind/list' })
      if (!r.ok) return []
      const v = r.value as unknown as RewindListResult
      rewindListCacheRef.current = v
      return v.snapshots.map(({ externallyChanged: _ec, ...m }) => m)
    },
    detectExternalChanges: async (_sessionId: string, seq: number): Promise<string[]> => {
      return rewindListCacheRef.current?.snapshots.find((s) => s.seq === seq)?.externallyChanged ?? []
    },
    revert: async (_sessionId: string, seq: number): Promise<{ restored: string[]; externalChanged: string[] }> => {
      const r = await host.send({ op: 'rewind/exec', target: seq })
      if (!r.ok) throw new Error(r.error)
      return r.value as unknown as { restored: string[]; externalChanged: string[] }
    },
  }

  // 事件→UI 映射（渲染/审批/插话/进度全事件驱动；回调直驱 setState 的旧路径退役）。
  // handler 经 ref 持有：2026-09-02 自愈链降级换宿主后，新宿主重订阅的是同一份处理逻辑
  const mountedRef = useRef(true) // 审阅 P2：unmount 后 in-flight rescue 不再建新宿主
  const hostEventHandlerRef = useRef<(ev: import('../protocol/types.js').ProtocolEvent) => void>(() => {})
  hostEventHandlerRef.current = (ev) => {
      // Ctrl+C 立即停：中断后到下一轮 turn/started 之间的动态帧（delta/item/thinking/usage）
      // 是宿主后台收敛的残渣——丢弃不渲染（transcript 权威在宿主，轮末/下轮重建自纠）
      if (interruptedAtRef.current && (ev.type === 'delta' || ev.type === 'item/started' || ev.type === 'item/completed' || ev.type === 'item/executing' || ev.type === 'thinking' || ev.type === 'usage')) return
      if (ev.type === 'turn/started') interruptedAtRef.current = false
      // G+ 合帧配套：任何非 delta 帧到达先同步 flush delta 缓冲（thinking/item 等事件与文本的
      // 时间线顺序不可倒置；turn/completed 收尾也不丢尾部文本）
      if (ev.type !== 'delta') {
        const buf = deltaBufRef.current
        if (buf.timer !== null) {
          clearTimeout(buf.timer)
          buf.timer = null
        }
        if (buf.text !== '') {
          const chunk = buf.text
          buf.text = ''
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, { type: 'delta', seq: ev.seq - 1, turnId: (ev as { turnId?: string }).turnId ?? '', text: chunk }, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
        }
      }
      switch (ev.type) {
        case 'delta': {
          // 活动流 B4：净化（stripper）→ 归约；G+ 四件套之四：16ms 合帧（每 token 一次 setState
          // 是高频重渲主源——缓冲批量 dispatch；其他帧到达时同步 flush 防时间线乱序）
          const clean = streamStripperRef.current.push(ev.text)
          const buf = deltaBufRef.current
          buf.text += clean
          if (buf.timer === null) {
            buf.timer = setTimeout(() => {
              buf.timer = null
              const chunk = buf.text
              buf.text = ''
              if (chunk !== '') {
                setActive((a) => ({
                  ...a,
                  timeline: timelineReducer(a.timeline, { type: 'delta', seq: ev.seq, turnId: ev.turnId, text: chunk }, { now: Date.now, nextId: tlDepsRef.current.nextId }),
                }))
              }
            }, 16)
          }
          break
        }
        case 'thinking':
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, ev, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
          break
        case 'thinking/ended':
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, ev, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
          break
        case 'item/executing':
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, ev, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
          break
        case 'turn/started':
          // 活动流 B4（§3.3 双清空点权威）：函数式只重置 timeline——不动 userInput/confirm/
          // streaming（doSubmit 整对象重置保留为发送失败回执窗口兜底，两处幂等）
          setActive((a) => ({ ...a, timeline: [] }))
          break
        case 'item/started':
          // 审阅 P2：时间线源（Ctrl+T）读 messagesRef——仅轮末同步时 busy 中看不到当前轮；
          // 工具事件粒度同步（逐 delta 太热），transcript 此时已含本轮已发生条目
          syncRefOnly()
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, ev, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
          setActivity({ state: 'tool', text: ev.name })
          break
        case 'item/completed': {
          syncRefOnly()
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
                // F-34：item/read 已带 HistoryStore 落盘 fallback（投影派压缩不删消息）——
                // miss 只剩「结果确实不存在/极早期未落盘」，不再臆测压缩
                pushNoticeFn('warn', `工具 ${ev.name} 全文拉取失败（结果未在会话记录中找到），查看器仅 4KB 截断版`)
              }
            })
          }
          // 活动流 B4：按 id 原位回填（itemId 同源修复后闭环；旧 findIndex(running&&name) 同名并行错位退役）
          setActive((a) => ({ ...a, timeline: timelineReducer(a.timeline, ev, { now: Date.now, nextId: tlDepsRef.current.nextId }) }))
          setActivity({ state: 'thinking' })
          break
        }
        case 'usage':
          recordUsage(ev.input, ev.output, { read: ev.cacheRead, creation: ev.cacheCreation })
          // F-44：上下文占用/余量（帧缺省=旧宿主/非 LLM 轮，保留上次值）
          if (ev.contextUsed !== undefined) {
            setCtxUsed(ev.contextUsed)
            lastCtxUsedRef.current = ev.contextUsed
          }
          if (ev.contextWindow !== undefined) setCtxWindow(ev.contextWindow)
          break
        case 'thread/status':
          runningRef.current = ev.busy
          if (ev.busy && turnStartedAtRef.current === null) {
            turnStartedAtRef.current = Date.now()
            setTurnStartedAt(turnStartedAtRef.current)
          }
          if (!ev.busy && turnStartedAtRef.current !== null) {
            turnStartedAtRef.current = null
            setTurnStartedAt(null)
          }
          setRunning(ev.busy)
          setIter(ev.iter)
          if (ev.maxIter !== undefined) setMaxIter(ev.maxIter)
          break
        case 'activity':
          // F-38：中断提示从内容区（ActivityBar 黄字）收敛到底部告警行——info 级 5s 自动消失
          // （去重机制防同轮多帧重复入队）
          if (ev.state === 'aborted') setSystemMsgs(['已中断，内容已保留'])
          setActivity({ state: ev.state as ActivityState, text: ev.text })
          break
        case 'turn/completed':
          // M14-V4（§3.3 查因后拍板方案一）：轮末即 commit——本轮 transcript 在 completed 时已
          // 终局（afterTools 是轮间回喂、跨 turn 通知是下轮注入，无漏消息风险），全量送 Static
          // 后动态区清零（空闲态只剩输入+状态栏，永不超限——轮末 markdown 滞留是最大溢出源）。
          // M2 的延迟 commit（下次 submit 才收）是「留动态区可 Ctrl+O 展开」的交互决策；
          // Static 的工具组本就展开（M3 §7.5），滚轮回看语义更优。error 轮无 completed 帧，
          // submit 开头的兑现兜底保留
          void pullTranscript().then((l) => {
            setActivity((cur) => (cur.state === 'aborted' ? cur : { state: 'idle' }))
            if (l.length > 0) {
              messagesRef.current = l
              setCommitted(messagesToCommitted(l))
              setActive(createActive())
            } else {
              setActive((a) => ({ ...a, streaming: false }))
            }
          }).catch(() => setActivity((cur) => (cur.state === 'aborted' ? cur : { state: 'idle' })))
          break
        case 'warn':
          pushNoticeFn('warn', ev.text)
          break
        case 'sandbox/mode':
          // 同对话档位变化即时对齐（用户拍板：同项目不同对话不互相影响——mux 信封 sessionId
          // 过滤+channel 会话私有保证只收当前会话；本端 Tab 切档回声/restoreFrom 归零帧幂等）
          applySandboxMode(ev.mode)
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
          syncCommitted()
          setSystemMsgs(['✓ 已压缩对话（旧消息已摘要进上下文，原文仍显示）'])
          break
        case 'compacting':
          setSystemMsgs(['正在压缩对话...'])
          break
        case 'compactFailed':
          setSystemMsgs(['（压缩未完成——对话太短或摘要失败，稍后自动重试）'], 'warn')
          break
        case 'approval/requested': {
          confirmRef.current = true
          // F-47 批 0：审批是安全边界，优先级高于查看器——强制退出 overlay（含 output
          // 面板）回主界面亮卡。否则审批卡在面板下不可见，15min 超时盲拒用户毫无感知
          // （安全审阅 P1-3）。setOverlay 包装同时复位 pickerRef，useInterrupt 恢复可用。
          // 审阅 P0-3：必须走 closeOutputPanel（teardown 三件套）——只 setOverlay(null)
          // 不解 altActiveRef 冻结，轮末 commit 永久进暂存，主对话静默停更
          const forcedOverlay = overlayRef.current
          if (forcedOverlay?.kind === 'output-panel' || forcedOverlay?.kind === 'output-view') closeOutputPanel()
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
        case 'askUser/requested': {
          // 审阅 P0-3：askUser 覆盖 output 面板前先 teardown（不复位 altActiveRef 即吞后续 commit）
          const askPrev = overlayRef.current
          if (askPrev?.kind === 'output-panel' || askPrev?.kind === 'output-view') teardownAltFrame()
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
        }
        case 'askSelect/requested':
          // T 线 T2：宿主 askSelect 可答帧（.mcp.json 批准门等）——协议选项卡，应答经命令回宿主
          setProtoSelect({ requestId: ev.requestId, title: ev.title, options: ev.options })
          break
        case 'askSelect/resolved':
          setProtoSelect(null)
          break
        case 'subagent/progress':
          setSubagents(ev.agents as SubagentStatus[])
          break
        case 'queue/snapshot':
          setQueuedInterjects(ev.items)
          break
        case 'session/updated':
          // 2026-09-02：归档/重命名多端同步不再静默（本次事故盲区——他端归档了本会话，
          // TUI 无任何提示直到恢复失败）。归档当前会话=底部警示常驻；其余仅留痕。
          if (ev.archived === true) {
            pushNoticeFn('error', `会话 ${ev.sessionId === deps.history.currentSessionId() ? '（当前会话）' : ev.sessionId} 已被归档（历史列表默认不再显示）`)
          }
          break
        case 'interjection/injected':
          // 宿主注入后紧随 queue/snapshot 全量同步；此处先摘除本条防一帧延迟
          setQueuedInterjects((prev) => prev.filter((t) => t !== ev.text))
          break
        default:
          break // 其余事件 B5 消费或无需 UI
      }
  }
  useEffect(() => {
    host.mountBridges?.()
    const unsub = host.subscribe((ev) => hostEventHandlerRef.current(ev))
    return () => {
      unsub()
      mountedRef.current = false
      // dispose 当前宿主（ref 取——自愈降级换宿主后 unmount 要收的是新宿主；旧通道在降级时已退役）
      hostRef.current?.dispose?.()
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
    // transcript 里的本轮内容在这里收进 Static 再开新轮）。**await 串行化**：兜底重建完成
    // 后才 echo——否则两者交错时 echo 基于重建前镜像追加、重建再在其后覆盖，transcript
    // user 项与 echo 项同内容双份上屏（2026-09-02 回归实证）
    await syncCommitted()
    // 2026-09-02 串台回归修复：附着态首个 prompt 不带信封 sessionId，serve 缺省路由落**项目
    // 默认会话**——同项目第二个 TUI 同样落默认会话，两终端互进对方 messages、事件互播（真机
    // 双开串台）。首个 prompt 前显式 session/new（serve 层真新建）拿专属会话；Embedded 形态
    // 本就是进程私有会话，不经此路径。
    if (attached && attachedSidRef.current === undefined) {
      let nr = await host.send({ op: 'session/new' })
      // 首命令也可能撞上后台失联（daemon 崩溃后首个输入）——同样走自愈链再试一次；
      // 降级路径（local）会话已由 degrade 建立，直接放行（本地宿主无 session/new 命令）
      if (!nr.ok && nr.code === 'NETWORK') {
        const outcome = await rescueDaemon()
        if (outcome === 'local') nr = { ok: true, sessionId: attachedSidRef.current }
        else if (outcome === 'reattached') nr = await (hostRef.current ?? host).send({ op: 'session/new' })
      }
      if (!nr.ok || nr.sessionId === undefined) {
        setActive((a) => ({ ...a, streaming: false }))
        setSystemMsgs([`新建会话失败：${nr.ok ? '回执缺 sessionId' : nr.error}`], 'warn')
        setActivity({ state: 'idle' })
        return
      }
      recordSessionId(nr.sessionId)
    }
    // T 线⑥：SessionStart additionalContext 宿主暂存随首轮注入（startTurn 内）——
    // 原 pendingSessionCtxRef 客户端机制退役（附着态注入点同样在宿主，web/TUI 一致）
    // 消息确认发送：粘贴暂存此刻清空（早退路径均不清——图片不丢）
    pendingImagesRef.current = []
    setPendingImages([])
    setActive({ ...createActive(), userInput: display ?? input, streaming: true })
    streamStripperRef.current = createAnsiStripper() // 新轮重置（半截序列不跨轮）
    setError(null)
    setActivity({ state: 'thinking' })
    // 首发也走 hostRef（审阅 P0-1 修复）：自愈降级会替换 hostRef 并 dispose 旧 transport——
    // 本 async 闭包固化的 host 已死，返 DISPOSED≠NETWORK 不入自愈重试，首条消息必失败
    let r = await (hostRef.current ?? host).send({
      op: 'prompt',
      text: input,
      mode: 'StartOrSteer',
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    })
    // TUI 稳定性（2026-09-02）：后台失联（daemon 崩溃/被杀）不弃用户输入——自愈链（重拉→
    // 降级本地）完成后重试一次；重试仍败才如实报错。rescue 单飞：自愈期间并发提交共等
    if (!r.ok && r.code === 'NETWORK' && attached) {
      const outcome = await rescueDaemon()
      if (outcome !== 'dead') {
        r = await (hostRef.current ?? host).send({
          op: 'prompt',
          text: input,
          mode: 'StartOrSteer',
          ...(images !== undefined && images.length > 0 ? { images } : {}),
        })
      }
    }
    if (!r.ok) {
      setActive((a) => ({ ...a, streaming: false }))
      setSystemMsgs([`发送失败：${r.error}`], 'warn')
      setActivity({ state: 'idle' })
      return
    }
    // T 线 T4：附着态隐式建会话——回执带 sessionId 记录为当前会话（后续命令信封路由）
    if (r.sessionId !== undefined) recordSessionId(r.sessionId)
    // 提交即锁死（2026-09-01 用户拍板）：发送成功立刻全文 echo 进 Static——执行期也能回看
    // 自己发的内容（原动态区 2 行折叠只在发送失败回执窗口保留，见 Conversation）。
    // echo 用 input（=transcript 权威文本；display 只是执行期标签），轮末 turn/completed
    // 全量重建时同位置同文；Ink Static 按已渲染游标只追加新项，已打印的 echo 不重印不重复。
    // 只在成功后 echo：失败时不进 transcript，乐观 echo 会让 committed 超前于 Ink 游标、
    // 下次全量重建数组变短 → 游标之后的真消息不再打印（静默丢屏）
    echoSeqRef.current += 1
    setCommitted([...committedRef.current, { kind: 'user', id: `echo${echoSeqRef.current}`, text: input }])
    setActive((a) => ({ ...a, userInput: '' }))
  }

  // P1 闪退面：doSubmit 前半段（图片组装/hook dispatch/getByType 等）在内部 try 之外，任一
  // reject → void submit(...) 成 unhandledRejection → cli 顶层 handler exit(1) 杀掉整个 TUI。
  // 包装层整体兜底（含 runningRef 复位——hook dispatch 抛出时已置 true，不复位则 TUI 永久 busy）。
  const submit = async (input: string, display?: string, blocks?: ContentBlock[]): Promise<void> => {
    // 输入体验批二期：粘贴 token 展开回全文再发（transcript 锁死语义=全文上屏）；
    // 按提交前的草稿剪枝已发送条目（删标签=删内容，CC prune images 同款）
    const expandedInput = expandPasteRefs(input, pastedStoreRef.current)
    for (const deadId of prunePasteRefs(pastedStoreRef.current, input)) pastedStoreRef.current.delete(deadId)
    input = expandedInput
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
      setSystemMsgs(['提交失败：' + (e instanceof Error ? e.message : String(e))], 'warn')
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
    pastedStoreRef.current.clear() // 审阅 P3：换会话不带旧会话的粘贴 token 全文
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
      setSystemMsgs(['（MCP 未启用）'], 'warn')
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
      setSystemMsgs(['MCP 重连失败：' + (e instanceof Error ? e.message : String(e))], 'warn')
    }
  }

  /** M6 S-P7：/skill-create——读会话 → LLM 起草 → 预览 → 创建/升级（人审卡点两处） */
  const skillCreate = async (): Promise<void> => {
    if (attached) {
      setSystemMsgs(['附着模式下 /skill-create 暂不可用（需本地模式）——已挂账产品化线'])
      return
    }
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

  /** M5：手动 /compact——T 线 T2 命令化：session/compact 宿主权威执行（压缩链+守卫在宿主），
   *  完成信号经 systemMsg 帧送达（宿主侧发出）；客户端只刷视图 */
  const compactManual = async (): Promise<void> => {
    if (!config.providers[config.current.name]) return
    setSystemMsgs(['正在压缩对话...'])
    try {
      const r = await host.send({ op: 'session/compact' })
      // 受理成功≠压缩成功——成败由宿主 systemMsg 帧（「压缩完成」/「压缩失败：…」）呈现；
      // compacted 帧（onCompacted）驱动 committed 重建（事件处理器内 syncCommitted）
      if (!r.ok) setSystemMsgs([`（压缩未开始——${r.error}）`])
    } catch (e) {
      setSystemMsgs([`压缩异常：${e instanceof Error ? e.message : String(e)}`])
    }
  }

  /** M5：切换 model 后检测 context 是否超新窗口（只提示风险，不自动压缩；用户主动 /compact） */
  const checkModelWindow = async (model: string, providerName: string): Promise<void> => {
    // T 线 T2：本地 estimateContextTokens 估算退役（skillListForPrompt/tools.specs 宿主面）——
    // usage 帧已带宿主权威 ctxUsed/contextWindow（F-44 同源真值），切模型后仅按新窗口比对提示
    try {
      const ctxTokens = lastCtxUsedRef.current ?? 0 // 无 usage 帧前=0（无对话无占用，不触发提示）
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
    // T 线 T2：恢复命令化——session/restore 宿主权威执行（载入 ensureRestore+SessionStart(resume)
    // 宿主 dispatch 全在宿主侧，T1②）；客户端只刷新视图。原 deps.project.ensureRestore/
    // restoreFrom/forkSession/copyForResume 客户端手搓三连退役。
    // 2026-09-02 用户拍板：**继续原会话**（不带 fork——同 id 续写；原 fork:true 会复制一份
    // 新会话，历史列表每次恢复多一条，用户要的是接着聊）。与 web 端恢复语义对齐（ensure）。
    // 附着态发送前先切 transport 会话 id：信封若还带旧会话 id，serve 按①显式路由进旧会话
    // （旧会话被回收时直接 404），且回执顶层 sessionId 被信封 id 覆盖拿不到目标 id。
    transportRef.current?.setSessionId?.(sessionId)
    const r = await host.send({ op: 'session/restore', sessionId })
    if (!r.ok) {
      // 恢复失败回滚 transport（目标未载入，事件过滤与信封仍指旧会话）
      const prev = attachedSidRef.current
      if (prev !== undefined) transportRef.current?.setSessionId?.(prev)
      setSystemMsgs([`⚠ 恢复失败：${r.error}，未切换`])
      return
    }
    // P0 修复（审阅）：消费回执的新 sessionId——后续命令信封与事件帧过滤都以它为准；
    // 附着态由 MultiTransport.setSessionId 更新分发基线。value 优先（serve 层会把顶层
    // sessionId 覆盖为信封 id），顶层兜底（Embedded 内联端口 value 形态缺省时）
    const value = r.value as { sessionId?: string } | undefined
    const sid = value?.sessionId ?? r.sessionId
    if (sid !== undefined) recordSessionId(sid)
    // 审阅 P0-2 修复：本地 makeDeps 形态（--local 或自愈降级后），dispatch 的 ensureConversation
    // 只是把目标会话 ensure 进 ProjectHost（新宿主），发起宿主（hostRef）仍是旧会话——不切换
    // 则显示换新（read 按 cmd.sessionId 直读文件）而续聊上下文/落盘全走旧会话宿主（读写分裂：
    // 模型看不到恢复的历史、轮末写旧文件、pullTranscript 读不到新轮 → 刚发的消息从屏幕消失）。
    // 附着形态由 serve 信封路由+前置 setSessionId 兜住，不经此分支。
    if (transportRef.current === null && deps.project !== undefined && sid !== undefined) {
      const target = await deps.project.ensureRestore(sid)
      const old = hostRef.current
      hostRef.current = target
      target.subscribe((ev) => hostEventHandlerRef.current(ev))
      ;(old as { dispose?: () => void }).dispose?.()
    }
    resetTransient()
    // 切对话档位对齐（用户拍板：同项目不同对话不互相影响——本地显示不得携带旧对话切过的
    // 档；活对话拉回它自己的档，冷对话=default。restoreFrom 归零广播通常已对齐，此处拉取
    // 兜住同实例端口与广播丢失两条缝）
    syncSandboxFromHost()
    const lines = await pullTranscript()
    messagesRef.current = lines
    setCommitted(messagesToCommitted(lines))
  }
  // CLI `ecode --history <id>` 启动恢复：复用 /history 的 restoreSession（继续原会话续写，
  // 2026-09-02 用户拍板不再 fork 复制）。
  // host 由 hostRef 渲染期惰性构造，effect 执行时已就绪；restoreSession 每渲染重建不列依赖，
  // prop 为启动期常量——仅随它触发一次。
  useEffect(() => {
    if (initialHistorySessionId !== undefined) void restoreSession(initialHistorySessionId)
  }, [initialHistorySessionId])

  // —— 2026-09-02 TUI 稳定性拍板（用户定调：附着状态不能打断 TUI 干活）——daemon 失联自愈链 ——
  // 三级：①命令 NETWORK 失败 → 重拉 daemon（resurrectDaemonReg）→ transport 热重连（不换实例，
  // 事件订阅零扰动）→ 冷拉回当前会话 → 重试原命令；②重拉失败 → 本地降级（localFallback 全装配
  // + 当前镜像续写同一会话文件）——TUI 永不断聊；③降级件也缺（测试 fake）→ 明确提示不卡输入。
  const rescueInflightRef = useRef<Promise<'reattached' | 'local' | 'dead'> | null>(null)
  const degradeToLocal = (): 'local' | 'dead' => {
    if (!mountedRef.current) return 'dead' // 审阅 P2：unmount 后 in-flight rescue 尾段不再建新宿主（无人 dispose 会泄漏）
    // 会话 id：优先 daemon 侧真实会话（续写同一文件）；从未建立（首命令即失联）时 undefined——
    // 由 cli 侧 localFallback 闭包兜底新 id（本地开新会话继续干活）
    const sid = attachedSidRef.current ?? (deps.history.currentSessionId() || undefined)
    if (localFallback === undefined) {
      // 审阅 R6/P2-1：dead 也收死轮（不收则 running 恒真、输入全进插话队列=注释宣称不卡实际卡）
      const tail = closeDeadTurn('后台服务不可达')
      setSystemMsgs([...tail, '✗ 后台服务不可达且重拉失败——输入已退回，可稍后重试或重启 ecode'], 'warn')
      rescueDeadLatch.current = true // 熔断：防 tick 每 8s 重拉×15s 超时无限循环
      return 'dead'
    }
    const fbDeps = localFallback(sid, configRef.current) // 审阅 P1：传活 config——/model、/setup 的切换不随降级回退启动快照
    const localHost = buildInlineHost(fbDeps)
    // 审阅 P2：优先磁盘全量（messagesRef 镜像最后同步在上一轮末——daemon 崩在轮中时本轮已落盘
    // 的尾部行只在磁盘；上下文缺尾=续聊遗漏）。磁盘无此会话再退镜像（同机 sessions 目录共享）
    const diskLines = sid !== undefined ? fbDeps.history.restoreFull(sid) : []
    ;(localHost as { restoreFrom?: (l: HistoryLine[]) => void }).restoreFrom?.(diskLines.length > 0 ? diskLines : messagesRef.current)
    // 旧通道退役（dispose 清订阅断泵）；宿主切换 + 同一份事件处理重订阅；后续渲染 host 即新宿主
    ;(host as { dispose?: () => void }).dispose?.()
    transportRef.current = null
    hostRef.current = localHost
    // 本地会话 id 上位（fbDeps.history 绑传入 id；首命令即失联的兜底新 id）——后续 prompt 的
    // session/new 分支与 transcript 读面都以它为准，不再碰已死的后台
    attachedSidRef.current = fbDeps.history.currentSessionId() || sid || attachedSidRef.current
    localHost.subscribe((ev) => hostEventHandlerRef.current(ev))
    // 降级宿主是全新实例（档位回 config 默认）——重放客户端当前档保持约束连续，方向与
    // syncSandboxFromHost 相反（此处客户端档才是用户意图）。full-access 提档走宿主 Broker
    // 审批卡（降级窗口后重新提权须再确认，防静默提权）；拒绝/失败则显示回落 default 对齐真档
    const degradeMode = sandboxModeRef.current
    if (degradeMode !== 'default') {
      void localHost
        .send({ op: 'sandbox/set', mode: degradeMode })
        .then((r) => {
          if (!r.ok) applySandboxMode('default')
        })
        .catch(() => {})
    }
    // 审阅 P2：直供镜像（走 pullTranscript 会打向刚 dispose 的旧闭包 transport——死链路）
    syncCommitted(diskLines.length > 0 ? diskLines : messagesRef.current)
    // 轮收场（reattached/degraded 共用——审阅 R6/P0-1：原轮随宿主死，turn/completed 永不到；
    // 不收场则 running 恒真 → 斜杠命令门全锁 + 输入全进死队列 = 换了个堵法）
    const tail = closeDeadTurn('后台服务不可达')
    // 安全席 P1：同 id 双写警示——降级存活期间他端（手机/飞书/新 daemon）打开同会话会交错落盘。
    // 审阅 R6/P0-2：单次合并调用（setSystemMsgs 全量替换语义——分两次调用前条被后条覆盖=静默丢退回提示）
    setSystemMsgs([
      ...tail,
      '⚠ 后台服务不可达——已切换本地模式续聊（同 id 续写；期间请勿在其他端打开本会话，/restart 或重启 ecode 回后台）',
    ], 'warn')
    return 'local'
  }

  /** 审阅 R6：死轮收场（降级/重连两路径共用）——中断语义收轮 + 时间线封口 + 挂起审批作废 +
   * 排队插话退回（单条塞回草稿免重打）。返回追加到提示数组的退回条目（可能为空）。 */
  const closeDeadTurn = (reason: string): string[] => {
    const notes: string[] = []
    if (runningRef.current) {
      runningRef.current = false
      setRunning(false)
      // 审阅 R6/P1-3（渲染）：activity 不收则 spinner 永转（计时已停但 state 停 thinking/tool
      // 仍转圈）——aborted 空行占位与 onInterrupt 语义对齐
      setActivity({ state: 'aborted' })
      if (turnStartedAtRef.current !== null) {
        turnStartedAtRef.current = null
        setTurnStartedAt(null)
      }
      // 审阅 R6/P2-2（渲染）：deltaBuf 防御清理（封口后 pending timer flush 会 append 新
      // live 段无人再封——触发窗理论为零，防御一行成本极低）
      const dbuf = deltaBufRef.current
      if (dbuf.timer !== null) {
        clearTimeout(dbuf.timer)
        dbuf.timer = null
      }
      dbuf.text = ''
      setActive((a) => {
        // 挂起审批随轮作废（审阅 R6/P1-1：不 resolve 则主输入框恒 inactive + 新宿主 NOT_PENDING 静默吞答）
        if (a.confirm !== null) {
          a.confirm.resolve(false)
          notes.push('⚠ 挂起的审批已随轮作废（原因：' + reason + '）——如需执行请重发指令')
        }
        return { ...a, confirm: null, streaming: false, timeline: a.timeline.map((e) => (e.kind === 'text' && e.live ? { ...e, live: false } : e)) }
      })
      confirmRef.current = false
      if (queuedInterjects.length > 0) {
        // 审阅 R6/P1-2：最后一条塞回草稿（免凭记忆重打）；其余以摘要列示。图片标签可能已失效
        //（pendingImages 随 submit 清空）——塞回时剪枝 [图片#N] 防幽灵标签
        const last = queuedInterjects[queuedInterjects.length - 1] ?? ''
        const cleaned = last.replace(/\[图片#\d+\]\s*/g, '').trim()
        if (cleaned !== '') {
          setInputDraft({ text: cleaned, seq: nextInsertSeq() })
        }
        notes.push(
          `⚠ 排队的 ${queuedInterjects.length} 条消息已退回（旧队列随${reason}失效）：最后一条已放回输入框，其余请重发`,
          ...queuedInterjects.slice(0, -1).map((q, i) => `  ${i + 1}. ${q.length > 40 ? q.slice(0, 40) + '…' : q}`),
        )
        setQueuedInterjects([])
      }
    }
    return notes
  }
  const rescueDaemon = (): Promise<'reattached' | 'local' | 'dead'> => {
    if (rescueInflightRef.current !== null) return rescueInflightRef.current // 单飞：并发提交共等一次重拉
    const p = (async (): Promise<'reattached' | 'local' | 'dead'> => {
      setSystemMsgs(['后台服务失联——正在重拉…'], 'warn')
      deps.logger.warn('daemon', 'rescue_started', {})
      // 审阅 R6：拉起前记录注册身份（同实例抖动 vs 新实例判别——同实例活轮还在流，
      // 收场会冻结流文本=误杀；新实例旧轮必死必须收场）
      const prevReg = readServerReg()
      const reg = await resurrectDaemonReg(deps.logger)
      const transport = transportRef.current
      if (reg !== null && transport?.reattach !== undefined) {
        transport.reattach(`http://127.0.0.1:${reg.port}`, reg.token)
        // daemon 重启后内存会话空——冷拉回当前会话（ensureRestore 同 id 续写，历史文件在同机共享）
        if (attachedSidRef.current !== undefined) {
          transport.setSessionId?.(attachedSidRef.current)
          const rr = await (hostRef.current ?? host).send({ op: 'session/restore', sessionId: attachedSidRef.current })
          if (rr.ok) syncCommitted()
          // 审阅 R6（原 P2 的假话覆盖修正）：找回失败提前收场返回——原实现在下方被无条件
          // 「✓ 会话已找回」覆盖，警告从未可见
          else {
            const tail = closeDeadTurn('后台服务中断')
            setSystemMsgs([...tail, '⚠ 后台已重连，但会话找回失败——续聊上下文可能为空，可 /history 重选'], 'warn')
            return 'reattached'
          }
        }
        // daemon 重拉=宿主必然重建（档位静默回 config 默认）——无论会话找回成败都拉宿主
        // 真档对齐显示，防「显示 read-only 实际 default」假安全（用户档位记忆随旧宿主死了）
        syncSandboxFromHost()
        // 审阅 R6/P0-1：新实例（pid 变）旧轮必死——收场防「已重连但 running 恒真」假忙碌；
        // 同实例（pid 同，SSE 抖动重连）活轮可能还在流——**不收场**（收了=冻结流文本误杀）
        if (reg.pid !== prevReg?.pid) {
          const tail = closeDeadTurn('后台服务中断')
          setSystemMsgs([
            ...tail,
            `✓ 后台服务已重连（新实例）${attachedSidRef.current !== undefined ? '，会话已找回' : ''}——原轮已随服务中断，已产出保留`,
          ])
        } else {
          setSystemMsgs(['✓ 后台连接已恢复（服务未中断——流可能仍在继续）'])
        }
        return 'reattached'
      }
      return degradeToLocal()
    })()
    rescueInflightRef.current = p
    void p.finally(() => {
      rescueInflightRef.current = null // 完成即清单飞——下次失联可再自愈
    })
    return p
  }

  /** Ctrl+C 立即停（用户拍板 2026-09-02）：本地中断时刻——此后到达的动态帧（delta/item/
   *  thinking）一律丢弃直到下一个 turn/started（宿主侧 loop 后台收敛，迟到的流残渣不再渲染） */
  const interruptedAtRef = useRef(false)
  const { warning } = useInterrupt({
    onInterrupt: () => {
      deps.logger.debug('system', 'interrupt_latency_probe', { stage: 'pressed' }) // 诊断插桩：四点计时起点
      // 本地 abort（hook 子进程中断）+ 宿主 interrupt（loop 的 signal 在宿主）。
      // 立即停拍板：本地**当场接管 UI**（不等宿主帧往返）——aborted 态+输入解锁+迟到帧丢弃；
      // 宿主帧回来（activity aborted/busy false）幂等覆盖
      abortRef.current.abort()
      interruptedAtRef.current = true
      runningRef.current = false
      setRunning(false)
      setActivity({ state: 'aborted' })
      setActive((a) => ({ ...a, streaming: false }))
      setSystemMsgs(['已中断（任务停止中——后台执行正在收敛，输入框已可用）'])
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
    // T 线⑥：SessionStart(startup) 宿主化——宿主构造时 dispatch（原挂载 effect 客户端 dispatch
    // 删除防双跑）；resume 路径随 restoreSession 命令化在 T2 一并迁移
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅启动一次
  }, [])




  // T5（D-T3 增补）：daemon 运行状态标识（附着态顶栏常驻——「前台上要能够看到后台是否在运行」）
  const [daemonState, setDaemonState] = useState<'open' | 'connecting' | 'backoff' | undefined>(
    attachedHost !== undefined ? 'open' : undefined,
  )
  // G3 轮中失联自愈（真机「搜题平台堵死」根因修复）：rescue 链原只挂命令发送路径——轮执行中
  // daemon 死亡时事件流断、轮恒 running、输入全进插话队列=永久堵死。此处补触发面：
  // backoff 持续 8s 且轮运行中 → 主动 rescueDaemon（重拉失败自动本地降级+轮收场）。
  // ref 桥防 stale closure（rescueDaemon 每渲染重建）
  const rescueRef = useRef<() => Promise<'reattached' | 'local' | 'dead'>>(() => Promise.resolve('dead'))
  rescueRef.current = rescueDaemon
  // 审阅 R6/P2-4：dead 熔断（localFallback 缺失形态下防 8s×15s 无限重拉循环刷日志——真机不达，测试态护栏）
  const rescueDeadLatch = useRef(false)
  useEffect(() => {
    if (attachedHost === undefined) return
    // 每 tick 读 hostRef 当前宿主（自愈降级换宿主后无 daemonState → 顶栏段自然隐藏）
    // G3：连续 backoff tick 计数（2s/tick × 4 = 8s 窗口——给 daemon 短暂重启留余量）
    let backoffTicks = 0
    let rescuing = false
    const timer = setInterval(() => {
      const st = (hostRef.current as TuiHost | null)?.daemonState?.()
      setDaemonState(st)
      // 审阅 R6/P1-1：非 open 即累加（半死 daemon——进程在事件循环卡——SSE 重连 fetch 挂满
      // open timeout，connecting 窗口 5s 级，仅计 backoff 会反复清零致 30-60s 延迟触发）
      if (st !== 'open' && st !== undefined) {
        backoffTicks += 1
        // 轮运行中 + 持续失联 + 未在自愈 + 非 dead 熔断 → 主动 rescue（命令路径外的事件流路径触发）
        if (backoffTicks >= 4 && runningRef.current && !rescuing && !rescueDeadLatch.current) {
          rescuing = true
          deps.logger.warn('daemon', 'midturn_rescue', {})
          // 审阅 R6/P2-2：tick 路径裸奔无 catch——rescue 内部抛（磁盘 IO/装配）会 unhandledRejection 杀 TUI
          void rescueRef
            .current()
            .catch(() => {})
            .finally(() => {
              rescuing = false
              backoffTicks = 0
            })
        }
      } else {
        backoffTicks = 0
      }
    }, 2000)
    timer.unref?.()
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（host 稳定）
  }, [])

  // 附着启动即拉宿主档位（TUI 重启附着活 daemon：宿主保留旧档而本地 useState 回默认——
  // 反向失同步，full-access 尤其危险：显示 default 有确认兜底，实际全放行）
  useEffect(() => {
    if (attachedHost === undefined) return
    syncSandboxFromHost()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach 期一次
  }, [])

  // T 线 T2：宿主 askSelect 可答帧（.mcp.json 批准门等）的协议选项卡态
  const [protoSelect, setProtoSelect] = useState<{ requestId: string; title: string; options: string[] } | null>(null)
  // M6 M-P7：MCP 状态（panel/data 拉取——附着态 McpManager 在 daemon；面板打开/动作后重拉）
  const [mcpSnapshots, setMcpSnapshots] = useState<McpPanelView['servers']>([])
  const mcpToolsRef = useRef<McpPanelView['tools']>({})

  useEffect(() => {
    void host.send({ op: 'panel/data', panel: 'mcp' }).then((r) => {
      if (r.ok) {
        const view = r.value as unknown as McpPanelView
        setMcpSnapshots(view.servers)
        mcpToolsRef.current = view.tools
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次（动作后由 mcpAction 重拉）
  }, [])
  // MCP 启动警告 + M8 指令/记忆截断提示 → 告警中心：T1⑪ 起由宿主 startupWarnings 随首次订阅
  // 以 notice 帧送达（此处客户端直读 deps.mcpWarnings 的旧路径退役）

  // M7 P4.5：skill 同名冲突汇总（非阻断——计数只认 skill 间遮蔽，命令遮蔽不算；引导自然语言消解）。
  // F-38：系统发现的问题走底部告警行（/warnings 可回看）——不随 systemMsgs 5s 消失
  useEffect(() => {
    const count = deps.skillRegistry.shadowedEntries.length
    if (count === 0) return
    pushNoticeFn('warn', `${count} 个 skill 同名冲突（/skill 查看详情；可直接让我改名或删除其一）`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载期一次
  }, [])

  // T 线 T2（D-T7）：项目 .mcp.json 批准门宿主协议化——宿主构造时发起 askSelect 可答帧
  // （TuiApp 的 askSelect/requested 事件处理器照常弹卡），客户端直调 deps.mcpPendingApproval 退役

  // F-50 批 3：Ctrl+O/Ctrl+E 废除（用户拍板「会触碰超限问题，留着没用」）——全量查看
  // 统一走 Ctrl+T 全屏面板（时间线视图按执行顺序展示全部流程，虚拟窗口渲染不卡）。
  // expandedTools/nextSingleExpand 数据结构保留（历史兼容），仅入口拆除。

  useInput(
    (input, key) => {
      // F-46/F-48：Ctrl+T 双向 toggle——output 系面板开着时再按=退出（CC「进来的键就是
      // 出去的键」）；否则进入全屏面板（enterAltScreen 同步先于 setOverlay 的 React 提交，
      // 架构审阅 P0-3 时序铁律）
      if (key.ctrl && input === 't') {
        if (overlay?.kind === 'output-panel' || overlay?.kind === 'output-view') {
          closeOutputPanel()
        } else {
          // F-48 批 2：降级链——NO_ALT_SCREEN（ECODE_NO_ALT_SCREEN=1 / tmux control-mode）
          // → 不写 1049 序列、altActiveRef 保持 false，面板树走嵌入式分支（审阅 P0-4）
          if (!NO_ALT_SCREEN) enterAltScreen()
          altActiveRef.current = !NO_ALT_SCREEN
          // F-50：Ctrl+T 默认落地执行时间线（按执行顺序展示全部流程与模型路径）；
          // l 键进来源列表（子代理/任务/单工具条目级查看）
          setOverlay({
            kind: 'output-view',
            title: '执行时间线（全部流程）',
            // 项 4：width getter 化——面板内 resize 折行宽度实时跟随（缓存按 width 自动重建）
            source: timelineSource(() => messagesRef.current, panelWidth),
          })
        }
      }
    },
    // P2-4：confirm 期间不抢 Ctrl+O/Ctrl+E/Ctrl+T（审批卡独占输入）；output 系 overlay
    // 打开时本 handler 保持活跃——Ctrl+T toggle 退出全屏面板靠它（F-48）
    { isActive: active.confirm === null && (overlay === null || overlay.kind === 'output-panel' || overlay.kind === 'output-view') },
  )

  // —— Ctrl+C 全局兜底（用户拍板「这次就该生效」）——
  // 裁决矩阵的最后一层：PanelShell 系面板/question/select 自有 Ctrl+C 退出（幂等，双重
  // 关闭无害）；真正无自处理的覆盖层（如 Wizard）由这里兜住。始终激活、收尾执行——
  // 中断/双击退出语义仍归 useInterrupt（pickerRef/confirmRef 让位矩阵不变），output 系
  // 面板走自己的 teardown 三件套，此处均不代劳。
  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'c')) return
      if (overlay === null) return
      if (overlay.kind === 'output-panel' || overlay.kind === 'output-view') return
      if (overlay.kind === 'question-panel') overlay.resolve({ kind: 'cancel' })
      if (overlay.kind === 'select') overlay.resolve(undefined)
      pickerRef.current = false
      setOverlay(null)
    },
    { isActive: true },
  )

  // 界面批 C3：空闲态双击 Esc（间隔 <500ms）直达 /rewind 面板（CC 双击 Esc 零成本入口对位）。
  // Esc 三态语义不破坏：面板开=关面板（overlay!==null 时不激活本 handler）、回填态=清空
  // （InputStream slash 回填 Esc 自处理——本 handler 只在空闲态激活）、审批卡=拒绝（confirm
  // 非 null 时不激活）。守卫：busy 不接管（运行中 rewind 有竞态）、checkpoint 未启用不响应
  // 清账 III P2-1：@ 下拉开着与否的同步读（主输入框 atEntries 状态在 InputStream 内——
  // 经 draft 端口同族的轻量探测：端口对象挂载期注册、read() 取活值；无端口时退化为 false）
  // D2 回归修复（2026-08-31 走查）：此前消费端写 `port !== null`——而端口是挂载期注册的
  // 常驻活对象（永非 null），致 escGuarded 恒真、双击 Esc 永久失效；改为持端口、事件时刻
  // 调 read() 取活值（守卫求值挪进回调，消除渲染闭包陈旧性）。
  const atOpenPortRef = useRef<{ read(): boolean } | null>(null)
  // 审阅 P2：Ctrl+R 搜索态活值端口（同 atOpen 端口族）——armed 守卫排除搜索态
  const searchOpenPortRef = useRef<{ read(): boolean } | null>(null)
  const lastEscRef = useRef(0)
  // 输入体验批（2026-08-31）：草稿非空时双击 Esc = 清空输入（armed 确认式）。第一次 Esc 进入
  // 待清态（输入区上方提示行「再按 Esc 清空输入」），1500ms 内第二次 Esc 才真清（对齐
  // useInterrupt 双击退出的 1500ms 窗）；任意草稿编辑/超时自动解除。@ 下拉开着时不 arm
  // （第一次 Esc 只关下拉，防长草稿中带 @ 误清）。空草稿双击维持开 /rewind 面板（<500ms）。
  const ESC_ARM_WINDOW_MS = 1500
  const [escArm, setEscArm] = useState<{ chars: number } | null>(null)
  const escArmAtRef = useRef(0)
  const escArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarmEscArm = useCallback((): void => {
    escArmAtRef.current = 0
    if (escArmTimerRef.current !== null) {
      clearTimeout(escArmTimerRef.current)
      escArmTimerRef.current = null
    }
    setEscArm(null)
  }, [])
  useInput(
    (_input, key) => {
      if (!key.escape) return
      const now = Date.now()
      // 清账 III P2-1：@ 下拉开着与否的同步读（端口活对象，事件时刻 read() 取活值）
      const atOpen = atOpenPortRef.current?.read() ?? false
      const searchOpen = searchOpenPortRef.current?.read() ?? false
      const draft = readMainDraft()
      // 分流一：草稿非空（且非 @ 下拉/搜索态）→ armed 清空流程
      if (draft !== '' && !atOpen && !searchOpen) {
        if (escArmAtRef.current !== 0 && now - escArmAtRef.current < ESC_ARM_WINDOW_MS) {
          disarmEscArm()
          clearMainDraft()
          lastEscRef.current = 0 // 清空后不与后续 Esc 配对成 rewind
          return
        }
        escArmAtRef.current = now
        setEscArm({ chars: draft.length })
        if (escArmTimerRef.current !== null) clearTimeout(escArmTimerRef.current)
        escArmTimerRef.current = setTimeout(() => disarmEscArm(), ESC_ARM_WINDOW_MS)
        lastEscRef.current = 0
        return
      }
      // 空草稿的 Esc 打断待清态（回填清空等让草稿变空的连击场景）
      disarmEscArm()
      // 分流二（现状）：空草稿双击 <500ms 开 /rewind；@ 下拉/搜索态只重置计时
      if (process.env.ECODE_DBG) console.error('[DBG esc-main]', { atOpen, searchOpen, since: now - lastEscRef.current })
      if (!atOpen && !searchOpen && now - lastEscRef.current < 500) {
        if (process.env.ECODE_DBG) console.error('[DBG rewind-open]')
        lastEscRef.current = 0
        setOverlay({ kind: 'rewind-panel' })
        return
      }
      lastEscRef.current = atOpen || searchOpen ? 0 : now
    },
    { isActive: overlay === null && active.confirm === null && !running },
  )

  // M6 M-P7：StatusBar MCP 段（有启用的 server 才显示；连接中瞬时态）。
  // 2026-09-02 精简批回调（用户反馈单字母看不懂）：保留 MCP 词干，去尾省宽
  const mcpSegment = useMemo(() => {
    if (mcpSnapshots.length === 0) return undefined
    const enabled = mcpSnapshots.filter((s) => s.status !== 'disabled')
    if (enabled.length === 0) return undefined
    if (enabled.some((s) => s.status === 'connecting')) return 'MCP 连接中'
    const connected = enabled.filter((s) => s.status === 'connected').length
    return `MCP ${connected}/${enabled.length}`
  }, [mcpSnapshots])

  // placeholder 判据改运行态镜像（streamingText 延迟 commit 常驻的旧病根治）
  const busy = running

  const fullCommitted: CommittedItem[] = committed

  // F-48 批 1：alt-screen 全屏面板——output 系 overlay 时动态区整体替换为面板树
  // （Static/InputStream 常驻不卸载，架构审阅 P0-2/P1-5）。
  // 审阅 P0-4：降级链（NO_ALT_SCREEN）下恒 false——altContent undefined 走嵌入式分支，
  // <AltScreen/> 不挂载（否则其 useInsertionEffect 补写 ENTER，降级照样进 alt buffer）
  const altActive = !NO_ALT_SCREEN && (overlay?.kind === 'output-panel' || overlay?.kind === 'output-view')
  const altContent: ReactNode = altActive ? (
    <>
      <AltScreen />
      {overlay?.kind === 'output-panel' && (
        <OutputListPage
          recentTools={recentTools}
          onOpen={(entry: OutputEntry) => {
            if (entry.kind === 'tool') {
              setOverlay({
                kind: 'output-view',
                title: `${entry.tool.name}（${entry.tool.itemId}）${entry.tool.truncated === true ? ' 〔截断，补全中〕' : ''}`,
                source: toolResultSource(() => recentToolsRef.current.find((t) => t.itemId === entry.tool.itemId), panelWidth),
                  backToList: true,
              })
            } else if (entry.kind === 'task') {
              const snap = taskRegistry.snapshot().find((t) => t.id === entry.id)
              setOverlay({
                kind: 'output-view',
                title: `task ${entry.id}：${snap?.command.slice(0, 50) ?? ''}（${snap?.status ?? '?'}）`,
                source: taskFileSource(entry.id, panelWidth),
                  backToList: true,
              })
            } else {
              setOverlay({ kind: 'output-view', title: `子代理 ${entry.id} transcript`, source: subagentSource(entry.id, panelWidth), backToList: true })
            }
          }}
          onExit={() => closeOutputPanel()}
          currentSid={deps.history.currentSessionId()}
          altMode
        />
      )}
      {overlay?.kind === 'output-view' && (
        <OutputViewer
          title={overlay.title}
          source={overlay.source}
          // onBack 按入口分流（backToList）：列表进入=回列表；Ctrl+T 直达=关整面板回主界面
          onBack={() =>
            overlay.backToList === true ? setOverlay({ kind: 'output-panel' }) : closeOutputPanel()
          }
          // F-50：l 键进来源列表（审阅 T3：曾无调用点=死键但状态行恒提示）
          onList={() => setOverlay({ kind: 'output-panel', })}
          altMode
        />
      )}
    </>
  ) : undefined

  // /model 可选项：providers 笛卡尔积（name × models），方案 §8.2
  const entries: ModelEntry[] = []
  for (const [name, cfg] of Object.entries(config.providers)) {
    for (const model of cfg.models) {
      entries.push({ name, model })
    }
  }

  // 审阅 P0-2：todo 常驻面板入预算账——行数派生（useMemo 防逐 delta 全量 flatMap，审阅 P2）
  // + 用与 Conversation 同一 allocateDynamic 纯函数自算 degraded（退化态 TodoPanel 整体隐藏，
  // 两处口径同源；todoLines 同入 conditions 让 Conversation 的 content 预算给清单让位）
  const { budget } = useViewport()
  const todoEntries = useMemo(
    () =>
      deriveLatestTodos([
        ...committed.flatMap((c) => (c.kind === 'tool-group' ? c.calls.map((call) => ({ name: call.use.name, use: call.use })) : [])),
        ...toolsOf(active.timeline).map((t) => ({ name: t.name, use: t.use })),
      ]),
    [committed, active.timeline],
  )
  const todoLines =
    todoEntries === null
      ? 0
      : Math.min(todoEntries.length, TODO_MAX_VISIBLE) + 1 + (todoEntries.length > TODO_MAX_VISIBLE ? 1 : 0)
  const tuiAlloc = allocateDynamic(budget, { tasksBar: tasksActive, subagentBar: subagents.length > 0, todoLines })

  return (
    <App
      key={clearKey}
      conditions={{ tasksBar: tasksActive, subagentBar: subagents.length > 0, todoLines }}
      model={config.current.model}
      banner={banner}
      committed={fullCommitted}
      active={active}
      altMode={altActive}
      altContent={altContent}
      onConfirm={clearConfirm}
      onCancel={clearConfirm}
      onDraftKey={handleConfirmDraftKey}
      draft={mainDraft}
      readDraft={() => draftPortRef.current?.read() ?? ''}
      onInterruptTurn={() => {
        // F-31：卡上 Ctrl+C=拒卡+中断整轮（用户拍板「按一下直接退出 loop」）
        void host.send({ op: 'interrupt' })
      }}
      activity={activity.state}
      activityText={(() => {
        // F-51：thinking 且有流式输出时显示已输出字数——极小终端一行也能知道在干什么（不黑盒）
        const live = liveTextOf(active.timeline)
        if (activity.state === 'thinking' && live !== '') {
          return `输出中 ${live.length} 字`
        }
        return activity.text
      })()}
      activityDetail={(() => {
        // R5（真机实证）：审批挂起期优先显示等待审批——「思考中 1m6s」实际在等用户应答属误导
        if (active.confirm !== null) return `等待审批：${active.confirm.use.name}`
        // 活动流 B4（用户点名「loading 处看到在想什么/在跑什么」）：
        // thinking 态=最新 live thinking 尾部（滚动语义在 ActivityBar 落地——此处保留**换行结构**
        // 的原文尾部 2000 字，不预截 40 字不抹换行：换行是「新行从头显示」的分段依据，
        // 用户拍板 2026-09-02）；tool 态=最新 executing digest（D9）
        if (activity.state === 'thinking') {
          for (let i = active.timeline.length - 1; i >= 0; i--) {
            const e = active.timeline[i]
            if (e.kind === 'thinking' && e.endedAt === undefined && e.text !== '') {
              const chars = Array.from(e.text) // R2/P2-4：按码点切（UTF-16 slice 可切半个 emoji）
              return chars.length > 2000 ? chars.slice(chars.length - 2000).join('') : e.text
            }
          }
          return undefined
        }
        if (activity.state === 'tool') {
          for (let i = active.timeline.length - 1; i >= 0; i--) {
            const e = active.timeline[i]
            if (e.kind === 'tool' && e.tool.digest !== undefined && e.tool.status === 'running') {
              return `正在执行 ${e.tool.digest}`
            }
          }
          return undefined
        }
        return undefined
      })()}
      turnStartedAt={turnStartedAt ?? undefined}
      running={running}
      queuedInterjects={queuedInterjects}
      daemon={(() => {
        // 2026-09-02 精简批回调（用户反馈 D✓ 看不懂）：中文短词，色随 daemonDanger
        if (daemonState === undefined) return undefined
        if (daemonState === 'open') return '后台运行'
        if (daemonState === 'backoff') return '后台重连中'
        return '后台连接中'
      })()}
      daemonDanger={daemonState === 'backoff'}
      mcp={mcpSegment}
      sandbox={sandboxMode === 'default' ? undefined : sandboxMode}
      sandboxDanger={sandboxMode === 'full-access'}
      memBytes={memBytes}
      tokens={tokens}
      ctxUsed={ctxUsed}
      ctxWindow={ctxWindow}
      iter={iter}
      maxIter={maxIter}
      warningLevel={(() => {
        const l = deriveNoticeLine(notices, noticeTick)
        return l === null || warning !== undefined ? undefined : l.level
      })()}
      warning={
        warning ?? (() => {
          const line = deriveNoticeLine(notices, noticeTick)
          return line === null ? undefined : renderNoticeLine(line, process.stdout.columns ?? 100)
        })()
      }
    >
      {/* 审阅 P0-1：条件段（子代理/任务条/错误横幅）计入帧高——alt 全屏模式一律收口，
          否则 busy 中 Ctrl+T（SubagentBar 活着）帧高被顶过 rows 触发 win32 每帧全清 */}
      {!altActive && (
        <>
          <SubagentBar agents={subagents} />
          <TasksBar />
          {error ? <ErrorBanner error={error} /> : null}
        </>
      )}
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
          shadowedByCommand={deps.skillRegistry.shadowedByCommand}
          shadowedEntries={[...deps.skillRegistry.shadowedEntries]}
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
          // T 线 T2（P1-3）：MCP 动作走 mcp/action 命令（附着态 McpManager 在 daemon）；
          // 动作完成后重拉 panel/data 快照
          onReconnect={async (n) => {
            await host.send({ op: 'mcp/action', action: 'reconnect', server: n })
            void host.send({ op: 'panel/data', panel: 'mcp' }).then((r) => {
              if (r.ok) setMcpSnapshots((r.value as unknown as McpPanelView).servers)
            })
          }}
          onDisconnect={async (n) => {
            await host.send({ op: 'mcp/action', action: 'close', server: n })
            void host.send({ op: 'panel/data', panel: 'mcp' }).then((r) => {
              if (r.ok) setMcpSnapshots((r.value as unknown as McpPanelView).servers)
            })
          }}
          onCancel={() => {
            pickerRef.current = false
            setOverlay(null)
          }}
          toolsOf={(n) => mcpToolsRef.current[n] ?? []}
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
      {protoSelect !== null && overlay === null && (
        // T 线 T2：宿主 askSelect 可答帧（.mcp.json 批准门等）——协议选项卡，应答经命令回宿主
        <Select
          title={protoSelect.title}
          items={protoSelect.options.map((o) => ({ label: o, value: o }))}
          onSelect={(v) => {
            void host.send({ op: 'askSelect/respond', requestId: protoSelect.requestId, choice: v })
            setProtoSelect(null)
          }}
          onCancel={() => {
            void host.send({ op: 'askSelect/respond', requestId: protoSelect.requestId, choice: null })
            setProtoSelect(null)
          }}
        />
      )}
      {overlay?.kind === 'output-panel' && altContent === undefined && (
        <OutputListPage
          recentTools={recentTools}
          onOpen={(entry: OutputEntry) => {
            if (entry.kind === 'tool') {
              setOverlay({
                kind: 'output-view',
                title: `${entry.tool.name}（${entry.tool.itemId}）${entry.tool.truncated === true ? ' 〔截断，补全中〕' : ''}`,
                source: toolResultSource(() => recentToolsRef.current.find((t) => t.itemId === entry.tool.itemId), panelWidth),
                  backToList: true,
              })
            } else if (entry.kind === 'task') {
              const snap = taskRegistry.snapshot().find((t) => t.id === entry.id)
              setOverlay({
                kind: 'output-view',
                title: `task ${entry.id}：${snap?.command.slice(0, 50) ?? ''}（${snap?.status ?? '?'}）`,
                source: taskFileSource(entry.id, panelWidth),
                  backToList: true,
              })
            } else {
              setOverlay({ kind: 'output-view', title: `子代理 ${entry.id} transcript`, source: subagentSource(entry.id, panelWidth), backToList: true })
            }
          }}
          onExit={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'output-view' && altContent === undefined && (
        <OutputViewer
          title={overlay.title}
          source={overlay.source}
          onBack={() =>
            overlay.backToList === true ? setOverlay({ kind: 'output-panel' }) : closeOutputPanel()
          }
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
          store={rewindProtocolStore}
          sessionId={deps.history.currentSessionId()}
          disabled={runningRef.current}
          onDone={(r) => {
            pickerRef.current = false
            setOverlay(null)
            if (r === null) return
            // T 线 T2：回退执行已宿主化（rewind/exec——文件还原+transcript 留痕+history 落盘+
            // applied 帧全在宿主）——客户端只刷新视图与提示
            syncCommitted()
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
      {overlay?.kind === 'devices-panel' && (
        <DevicesPanel
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
      {/* 审阅 P0-1：systemMsgs 同入帧账——alt 全屏模式收口（TTL 5s，退出面板即随重渲按
          剩余 TTL 显示或消失，无信息永久丢失） */}
      {!altActive && systemMsgs.length > 0 && (
        <Box flexDirection="column">
          {systemMsgs.map((m, i) => (
            <Text key={`sys${clearKey}_${i}`} color={m.level === 'warn' ? theme.warn : undefined} dimColor={m.level !== 'warn'}>
              {m.text}
            </Text>
          ))}
        </Box>
      )}
      {/* 任务清单常驻面板（2026-08-30 对标 CC/harness/opencode）：todo 清单不进对话流，
          最新整表显示在输入区上方、默认展开；数据源=最近一次 todo 调用（active 优先→committed） */}
      <TodoPanel
        altMode={altActive}
        // 审阅 P0-2：退化态（budget 装不下清单）整体隐藏——宁可不见也不触发 3J
        maxVisible={tuiAlloc.degraded ? 0 : TODO_MAX_VISIBLE}
        todos={todoEntries}
      />
      {/* 输入体验批：双击 Esc 待清态提示（仅空闲态显示；任意草稿编辑/1500ms 超时自动解除） */}
      {escArm !== null && overlay === null && active.confirm === null && !running && !altActive && (
        <Text dimColor>再按 Esc 清空输入（{escArm.chars} 字符）· 编辑或超时取消</Text>
      )}
      {/* F-48：alt 全屏面板期间 InputStream 保持挂载（草稿/历史位不丢）但 height 0 折叠
          + inactive 让出按键——面板独占键盘（架构审阅 P1-5） */}
      <Box height={altActive ? 0 : undefined}>
      <InputStream
        onSubmit={submit}
        onPasteImage={() => pasteImageFromClipboard()}
        onPasteText={handlePasteText}
        onExpandPaste={(t) => expandPasteRefs(t, pastedStoreRef.current)}
        onRegisterSearchOpen={(port) => {
          searchOpenPortRef.current = port
        }}
        onInterjectClear={() => {
          void host.send({ op: 'interjection/clear' })
        }}
        busy={runningRef.current}
        onSlashBusy={() => setSystemMsgs(['运行中暂不能执行命令（空闲后再发；插话请直接输入文字）'], 'warn')}
        onTabSandbox={() => {
          // F-33（用户拍板）：沙箱随时可切——TUI 侧忙碌拦截废除（宿主 getter 化后无口径分裂；
          // full-access 提档弹审批帧语义照旧）
          // M12-B3（审阅 P0-2 修复）：档位权威在宿主（sandbox/set）；full-access 提档经宿主 Broker 审批帧确认
          const next = nextSandboxMode(sandboxModeRef.current)
          if (next === 'full-access') {
            void host.send({ op: 'sandbox/set', mode: 'full-access' }).then((r) => {
              pickerRef.current = false
              if (r.ok) {
                applySandboxMode('full-access')
                setSystemMsgs(['沙箱模式：full-access（本会话副作用免确认）'])
              } else {
                setSystemMsgs([`提档未生效：${r.error}`], 'warn')
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
            // F-50 批 3：Ctrl+O/E 废除后 expand 命令退役——全量查看统一 Ctrl+T
            setSystemMsgs(['工具展开已并入 Ctrl+T 全屏面板（全量/可搜索）'], 'info')
            return
          }
          if (result.action === 'skill-panel') {
            setOverlay({ kind: 'skill-panel' })
            return
          }
          if (result.action === 'pick-model') {
            setOverlay({ kind: 'model-picker' })
            return
          }
          if (result.action === 'pick-history') {
            void host.send({ op: 'session/list', includeArchived: true }).then((r) => {
              if (r.ok) setHistoryMetas((r.value as unknown as SessionMeta[]))
            }).catch(() => {})
            setOverlay({ kind: 'pick-history' })
            return
          }
          if (result.action === 'start-setup') {
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
            setOverlay({ kind: 'warnings-panel' })
            return
          }
          if (result.action === 'open-devices-panel') {
            setOverlay({ kind: 'devices-panel' })
            return
          }
          if (result.action === 'open-config-panel') {
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
            setOverlay({ kind: 'sandbox-panel' })
            return
          }
          if (result.action === 'open-rewind-panel') {
            // T 线 T2：rewind 走协议（rewind/list+exec），未装配由宿主回 NOT_IMPLEMENTED——客户端不再判 checkpoint
            setOverlay({ kind: 'rewind-panel' })
            return
          }
          if (result.action === 'open-plugin-panel') {
            if (deps.pluginLoader == null) {
              setSystemMsgs(['plugin 系统未启用'])
              return
            }
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
            const u = lastUsageRef.current
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
        inactive={overlay !== null || active.confirm !== null || altActive}
        insert={insert}
        onRegisterDraft={registerPort}
        onDraftChange={(t) => {
          setMainDraft(t)
          // 输入体验批：任意草稿编辑解除待清态（清空动作自身触发的变更此时已解除，幂等）
          if (escArmAtRef.current !== 0) disarmEscArm()
        }}
        onRegisterAtOpen={(port) => {
          atOpenPortRef.current = port
        }}
        placeholder={
          active.confirm !== null
            ? '（审批中…打字进草稿，Y/N/Esc 应答）'
            : busy
              ? '（处理中，Ctrl+C 中断）...'
              : '输入消息，/help 查看命令...'
        }
      />
      </Box>
    </App>
  )
}
