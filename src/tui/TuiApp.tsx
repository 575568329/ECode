import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput, Text, Box } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { runLoop, type ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, HistoryLine, Message } from '../core/types.js'
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
export function TuiApp({ deps, banner: initialBanner }: { deps: TuiAppDeps; banner?: string }): ReactElement {
  const messagesRef = useRef<HistoryLine[]>([])
  const abortRef = useRef<AbortController>(new AbortController())
  const runningRef = useRef(false)
  // 同步 confirm 状态给 useInterrupt isActive（避免 stale closure；P0#1）
  const confirmRef = useRef(false)
  // 同步 picker 覆盖状态给 useInterrupt（同 confirm：覆盖期间 Ctrl+C 由 picker 处理，不中断 loop）
  const pickerRef = useRef(false)
  // ctxWindow 缓存（S-P4：submit 热路径同步用，启动解析一次 + 切模型刷新；默认 200k 兜底）
  const ctxWindowRef = useRef(200_000)
  // MCP 确认「本会话记住」前缀表（mcp__server；v3 P1-3，会话级不落盘）
  const confirmAlwaysRef = useRef(new Set<string>())

  const [committed, setCommitted] = useState<CommittedItem[]>([])
  const [active, setActive] = useState<ActiveState>(() => createActive())
  const [activity, setActivity] = useState<{ state: ActivityState; text?: string }>({
    state: 'idle',
  })
  const [error, setError] = useState<AppError | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
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
    | { kind: 'select'; title: string; options: string[]; resolve: (v: string | undefined) => void }
    | null
  >(null)
  // 面板回填通道（S-P6 D32：SkillPanel Enter → `/name ` 写入输入框，不直接执行）
  const [insert, setInsert] = useState<{ text: string; seq: number } | undefined>(undefined)
  // /history 打开时载入的会话列表（loadAll 只在打开时调一次，避免 render 热路径同步 IO）
  const [historyMetas, setHistoryMetas] = useState<SessionMeta[]>([])
  // banner（配置无效提示；初始从 cli 传入，/setup 成功后清，submit 配置无效时设）
  const [banner, setBanner] = useState<string | undefined>(initialBanner)

  const submit = async (input: string, display?: string): Promise<void> => {
    if (runningRef.current) return
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
    // 新轮：userInput 乐观显示 + streaming=true（流式灰字）。
    // display（S4.4 最小 display/content 分离）：手动 skill 触发时输入框/转录显示原始
    // `/name args`，消息本体是展开全文（runLoop 的 userInput 必须传全文，防 alreadyUser 双推）
    setActive({ ...createActive(), userInput: display ?? input, streaming: true })
    setError(null)
    setWarn(null)
    setActivity({ state: 'thinking' })
    abortRef.current = new AbortController()
    const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
    const providerReq = buildProviderReq(config)
    const system = buildSystemPrompt(deps.skillRegistry.listForPrompt(), ctxWindowRef.current)
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
          onUsage: (inp, out, cache) => {
            deps.lastUsage.input = inp
            deps.lastUsage.output = out
            deps.lastUsage.cacheRead = cache?.read ?? 0
            deps.lastUsage.cacheCreation = cache?.creation ?? 0
            setTokens((n) => n + inp + out)
            // M5：累加本轮成本（cache 四维拆分；未命中模型跳过不累加）
            const c = tokensToCost(config.current.model, {
              input: inp, output: out,
              cacheRead: cache?.read ?? 0, cacheCreation: cache?.creation ?? 0,
            })
            if (c != null) setSessionCost((s) => s + c)
          },
          onIter: (i, m) => {
            setIter(i)
            setMaxIter(m)
          },
          onActivity: (state, text) => setActivity({ state, text }),
          onWarn: (m) => setWarn(m),
        },
        providerReq,
        system,
        maxIterations: config.maxIterations,
        toolCtx: { cwd: process.cwd(), signal: abortRef.current.signal },
        signal: abortRef.current.signal,
        onBeforeRequest,
        onCompacted,
        confirm: async (use) => {
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
        },
      })
      // 不立即 commit：本轮保留在动态区（当前轮可 Ctrl+O 展开）；streaming=false 转 Markdown 显示
      setActive((a) => ({ ...a, streaming: false }))
      setActivity({ state: 'idle' })
    } catch (e) {
      // 中断/错误：同样保留动态区（用户看中断内容），下次 submit 才 commit
      setActive((a) => ({ ...a, streaming: false }))
      if (isAbortError(e)) {
        setActivity({ state: 'aborted' })
      } else {
        setError(toAppError(e))
        setActivity({ state: 'idle' })
      }
    } finally {
      runningRef.current = false
    }
  }

  // 清 confirm（ConfirmPrompt 内先 resolve 再调它）
  const clearConfirm = () => {
    confirmRef.current = false
    setActive((a) => ({ ...a, confirm: null }))
  }

  // 清动态/瞬态状态（onClear 和 restoreSession 共用；committed 由调用方设，§9.2 P2-6 别重写一套）
  const resetTransient = () => {
    // 兜底：若有挂起的 confirm（inactive 本应挡住命令触发，此处 defense-in-depth），取消避免 Promise 永挂
    if (active.confirm) {
      active.confirm.resolve(false)
      confirmRef.current = false
    }
    setActive(createActive())
    setSystemMsgs([])
    setTokens(0)
    setSessionCost(0)
    setIter(undefined)
    setMaxIter(undefined)
    setWarn(null)
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
        // 创建路径：预览（采用/放弃）
        const ok = await askPreviewConfirm(renderCreatePreview(candidate), 'skill-create')
        if (!ok) {
          setSystemMsgs(['（已放弃起草；可调整会话后再跑 /skill-create）'])
          return
        }
        const r = await deps.skillRegistry.install(candidate)
        setSystemMsgs([`✓ 已创建 skill「${candidate.name}」（${r.path}）`])
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
    deps.history.setSessionId(newId, config.current.model)
  }
  const { warning } = useInterrupt({
    onInterrupt: () => abortRef.current.abort(),
    // P0#1：confirm/picker 覆盖期间不 abort（由覆盖组件独占 Ctrl+C）
    isActive: () => confirmRef.current || pickerRef.current,
  })

  // ctxWindow 缓存初始化（S-P4）：启动解析一次（models.dev 预热已由 M5 #4 修复），失败保持默认
  useEffect(() => {
    void resolveContextWindow(config.current.model, config.providers[config.current.name]?.contextWindow)
      .then((w) => {
        ctxWindowRef.current = w
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
  // MCP 启动警告（无待批准事项时展示；有待批准时批准流的消息优先，警告并入其后）
  useEffect(() => {
    if ((deps.mcpWarnings?.length ?? 0) === 0) return
    const lines = deps.mcpWarnings!
    if (deps.mcpPendingApproval === undefined) {
      setSystemMsgs(lines.slice())
    } else {
      setSystemMsgs((prev) => [...prev, ...lines])
    }
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
      tokens={tokens}
      iter={iter}
      maxIter={maxIter}
      warning={warning ?? warn ?? undefined}
    >
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
        onSkillInvoke={(name, args) => {
          // S4.4 手动触发：展开全文作 userInput，原始 `/name args` 作 display
          const info = deps.skillRegistry.get(name)
          if (info === undefined) return
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
          if (result.action === 'cost') {
            const u = deps.lastUsage
            const lineCost = tokensToCost(config.current.model, {
              input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreation: u.cacheCreation,
            })
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
        inactive={overlay !== null || active.confirm !== null || runningRef.current}
        insert={insert}
        placeholder={busy ? '（处理中，Ctrl+C 中断）...' : '输入消息，/help 查看命令...'}
      />
    </App>
  )
}
