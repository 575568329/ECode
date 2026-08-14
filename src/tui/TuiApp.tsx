import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { runLoop, type ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, HistoryLine } from '../core/types.js'
import { makeOnBeforeRequest } from '../services/compaction/hook.js'
import { tokensToCost } from '../services/pricing.js'
import type { CompactionOrchestrator } from '../services/compaction/orchestrator.js'
import type { LLMProviderRegistry } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { createActive, type CommittedItem, type ActiveState } from './types.js'
import { messagesToCommitted, findUse } from './commit.js'
import { buildSystemPrompt } from '../core/system.js'
import { buildPreview } from '../services/preview.js'
import { buildProviderReq, loadConfig, writeWizardConfig, type Config } from '../services/config.js'
import { ModelPicker, type ModelEntry } from './ModelPicker.js'
import { HistoryPicker } from './HistoryPicker.js'
import { Wizard } from './Wizard.js'
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
    { kind: 'model-picker' } | { kind: 'pick-history' } | { kind: 'setup-wizard' } | null
  >(null)
  // /history 打开时载入的会话列表（loadAll 只在打开时调一次，避免 render 热路径同步 IO）
  const [historyMetas, setHistoryMetas] = useState<SessionMeta[]>([])
  // banner（配置无效提示；初始从 cli 传入，/setup 成功后清，submit 配置无效时设）
  const [banner, setBanner] = useState<string | undefined>(initialBanner)

  const submit = async (input: string): Promise<void> => {
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
    // 新轮：userInput 乐观显示 + streaming=true（流式灰字）
    setActive({ ...createActive(), userInput: input, streaming: true })
    setError(null)
    setWarn(null)
    setActivity({ state: 'thinking' })
    abortRef.current = new AbortController()
    const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
    const providerReq = buildProviderReq(config)
    const system = buildSystemPrompt()
    const onCompacted = (m: HistoryLine[]) => setCommitted(messagesToCommitted(m))
    const onBeforeRequest = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, system, onCompacted)

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
          // D5：callback 内部算预览（不污染 Tool 接口）；P1#3：catch 异常不杀 Loop
          const preview = await buildPreview(use, process.cwd()).catch(
            (e) => `⚠ 无法生成预览：${e instanceof Error ? e.message : String(e)}`,
          )
          confirmRef.current = true
          return new Promise<boolean>((resolve) => {
            setActive((a) => ({ ...a, confirm: { use, preview, resolve } }))
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
  /** M5：手动 /compact——触发编排器强制压缩 + 重建 committed（boundary 追加到 messagesRef） */
  const compactManual = async (): Promise<void> => {
    if (messagesRef.current.length === 0) return
    if (!config.providers[config.current.name]) return
    const provider = deps.providerRegistry.getByType(config.providers[config.current.name].type)
    const providerReq = buildProviderReq(config)
    const onCompacted = (m: HistoryLine[]) => setCommitted(messagesToCommitted(m))
    const hook = makeOnBeforeRequest(deps.orchestrator, provider, providerReq, buildSystemPrompt(), onCompacted)
    await hook(messagesRef.current, 'overflow') // overflow = 强制压缩（绕过阈值判定）
  }

  const restoreSession = (sessionId: string) => {
    const messages = deps.history.restore(sessionId)
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

  const busy =
    active.streamingText !== '' ||
    activity.state === 'thinking' ||
    activity.state === 'tool' ||
    activity.state === 'retry'

  // systemMsgs（/help 等命令输出）追加到 committed 末尾显示
  const fullCommitted: CommittedItem[] =
    systemMsgs.length > 0
      ? [
          ...committed,
          ...systemMsgs.map((m, i) => ({
            kind: 'assistant-text' as const,
            id: `sys${clearKey}_${i}`,
            text: m,
          })),
        ]
      : committed

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
      <InputStream
        onSubmit={submit}
        onCommand={(_cmd, result) => {
          if (result.action === 'expand') {
            toggleExpand()
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
        placeholder={busy ? '（处理中，Ctrl+C 中断）...' : '输入消息，/help 查看命令...'}
      />
    </App>
  )
}
