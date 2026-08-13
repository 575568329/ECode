import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { useInput } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { runLoop, type ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, Message } from '../core/types.js'
import type { LLMProvider } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import { createActive, type CommittedItem, type ActiveState } from './types.js'
import { messagesToCommitted, findUse } from './commit.js'

const SYSTEM_PROMPT = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}
回复用中文。`

/** 清屏（可见区 + scrollback + 光标归位）；/clear 用，清可见区残留 */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H'

export interface TuiAppDeps {
  provider: LLMProvider
  tools: ToolRegistry
  logger: Logger
  history: HistoryStore
  cfg: {
    providerName: string
    baseURL: string
    apiKey: string
    model: string
    maxIterations: number
  }
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
export function TuiApp({ deps }: { deps: TuiAppDeps }): ReactElement {
  const messagesRef = useRef<Message[]>([])
  const abortRef = useRef<AbortController>(new AbortController())
  const runningRef = useRef(false)

  const [committed, setCommitted] = useState<CommittedItem[]>([])
  const [active, setActive] = useState<ActiveState>(() => createActive())
  const [activity, setActivity] = useState<{ state: ActivityState; text?: string }>({
    state: 'idle',
  })
  const [error, setError] = useState<AppError | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [tokens, setTokens] = useState(0)
  const [systemMsgs, setSystemMsgs] = useState<string[]>([])
  const [iter, setIter] = useState<number | undefined>(undefined)
  const [maxIter, setMaxIter] = useState<number | undefined>(undefined)
  const [clearKey, setClearKey] = useState(0)

  const submit = async (input: string): Promise<void> => {
    if (runningRef.current) return
    runningRef.current = true
    // 乐观：当前轮 userInput 立即显示（折叠到 2 行由 Conversation 处理）
    setActive({ ...createActive(), userInput: input })
    setError(null)
    setWarn(null)
    setActivity({ state: 'thinking' })
    abortRef.current = new AbortController()

    try {
      await runLoop(messagesRef.current, input, {
        provider: deps.provider,
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
          onUsage: (inp, out) => setTokens((n) => n + inp + out),
          onIter: (i, m) => {
            setIter(i)
            setMaxIter(m)
          },
          onActivity: (state, text) => setActivity({ state, text }),
          onWarn: (m) => setWarn(m),
        },
        providerReq: {
          name: deps.cfg.providerName,
          baseURL: deps.cfg.baseURL,
          apiKey: deps.cfg.apiKey,
          model: deps.cfg.model,
        },
        system: SYSTEM_PROMPT,
        maxIterations: deps.cfg.maxIterations,
        toolCtx: { cwd: process.cwd(), signal: abortRef.current.signal },
        signal: abortRef.current.signal,
      })
      // commit：本轮按原序进 Static，active 清空（= 下一轮收起，不可再展开）
      setCommitted(messagesToCommitted(messagesRef.current))
      setActive(createActive())
      setActivity({ state: 'idle' })
    } catch (e) {
      // 中断/错误：固化已生成内容（orphan tool 补终态）
      setCommitted(messagesToCommitted(messagesRef.current))
      setActive(createActive())
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

  const { warning } = useInterrupt({ onInterrupt: () => abortRef.current.abort() })

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

  useInput((input, key) => {
    if (key.ctrl && input === 'o') toggleExpand()
  })

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

  return (
    <App
      key={clearKey}
      model={deps.cfg.model}
      committed={fullCommitted}
      active={active}
      onToggleTool={hasDoneTool ? toggleExpand : undefined}
      activity={activity.state}
      activityText={activity.text}
      tokens={tokens}
      iter={iter}
      maxIter={maxIter}
      warning={warning ?? warn ?? undefined}
    >
      {error ? <ErrorBanner error={error} /> : null}
      <InputStream
        onSubmit={submit}
        onCommand={(_cmd, result) => {
          if (result.action === 'expand') {
            toggleExpand()
            return
          }
          // 替换（不累积）：多次 /help 只显示最新
          setSystemMsgs(result.output ? [result.output as string] : [])
        }}
        onClear={() => {
          messagesRef.current = []
          setCommitted([])
          setActive(createActive())
          setSystemMsgs([])
          setTokens(0)
          setIter(undefined)
          setMaxIter(undefined)
          setWarn(null)
          setError(null)
          // 清可见区 + scrollback（清 Static 残留）+ 光标归位
          process.stdout.write(CLEAR_TERMINAL)
          // remount App（重置 <Static> 内部 index，避免 /clear 后消息不渲染）
          setClearKey((k) => k + 1)
        }}
        placeholder={busy ? '（处理中，Ctrl+C 中断）...' : '输入消息，/help 查看命令...'}
      />
    </App>
  )
}
