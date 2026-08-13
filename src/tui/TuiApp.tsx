import { useRef, useState, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { App } from './App.js'
import { InputStream } from './InputStream.js'
import { ErrorBanner } from './ErrorBanner.js'
import { UserMessage } from './UserMessage.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ToolCallView } from './ToolCallView.js'
import { useInput } from 'ink'
import { useInterrupt } from './useInterrupt.js'
import { runLoop, type ActivityState } from '../core/loop.js'
import { toAppError } from '../core/errors.js'
import type { AppError, Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../core/types.js'
import type { LLMProvider } from '../providers/interface.js'
import type { ToolRegistry } from '../tools/interface.js'
import type { Logger } from '../services/logger.js'
import type { HistoryStore } from '../services/history.js'
import type { ToolCallEntry } from './toolview.js'

const SYSTEM_PROMPT = `你是 ECode，一个终端 Agent CLI。你能通过工具读文件、执行命令，帮用户完成编程任务。
当前工作目录：${process.cwd()}
当前平台：${process.platform}
回复用中文。`

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

/** 把已 commit 的 messages 转成渲染项：user text / assistant text / 工具调用（配对 tool_result） */
function messagesToItems(messages: Message[], expandedAll?: boolean): ReactNode[] {
  const items: ReactNode[] = []
  // 收集所有 tool_result（配对 tool_use_id）
  const results = new Map<string, ToolResultBlock>()
  for (const m of messages) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') results.set(b.tool_use_id, b)
      }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as TextBlock).text)
        .join('')
      if (text) items.push(<UserMessage key={`u${i}`} text={text} />)
    } else if (m.role === 'assistant') {
      const texts = m.content.filter((b) => b.type === 'text') as TextBlock[]
      const uses = m.content.filter((b) => b.type === 'tool_use') as ToolUseBlock[]
      if (texts.length > 0) {
        items.push(<AssistantMessage key={`a${i}`} text={texts.map((t) => t.text).join('')} />)
      }
      for (const tu of uses) {
        items.push(
          <ToolCallView
            key={`t${tu.id}`}
            entry={{ use: tu, result: results.get(tu.id) }}
            expanded={expandedAll ? true : undefined}
          />,
        )
      }
    }
  }
  return items
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || 'aborted' in e)
}

/**
 * TuiApp：连接 AgentLoop 与 TUI（M2 第 6 步集成）。
 *
 * - 持有状态：messages / streamingText / toolEntries / activity / error
 * - loop callbacks → setState 驱动 TUI：
 *   onText→streamingText 灰字 / onToolStart→activity / onToolResult→toolEntries（渐进配对）
 *   / onActivity→activity / onWarn→warning
 * - 流式期：streamingText + toolEntries + ActivityBar；commit：messages 进 Static（items）
 * - Ctrl+C：useInterrupt → abortController.abort()，loop try/finally 固化已生成
 */
export function TuiApp({ deps }: { deps: TuiAppDeps }): ReactElement {
  const messagesRef = useRef<Message[]>([])
  const abortRef = useRef<AbortController>(new AbortController())
  const runningRef = useRef(false)
  const pairedRef = useRef<Set<string>>(new Set())

  const [messages, setMessages] = useState<Message[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [toolEntries, setToolEntries] = useState<ToolCallEntry[]>([])
  const [activity, setActivity] = useState<{ state: ActivityState; text?: string }>({ state: 'idle' })
  const [error, setError] = useState<AppError | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [tokens, setTokens] = useState(0)
  const [systemMsgs, setSystemMsgs] = useState<string[]>([])
  const [expandAll, setExpandAll] = useState(false)
  const [iter, setIter] = useState<number | undefined>(undefined)
  const [maxIter, setMaxIter] = useState<number | undefined>(undefined)
  const [clearKey, setClearKey] = useState(0)

  const submit = async (input: string): Promise<void> => {
    if (runningRef.current) return
    runningRef.current = true
    pairedRef.current = new Set()
    // 乐观：立即显示 user（不等 LLM；runLoop 检测末尾已 user 避免重复 push）
    messagesRef.current.push({ role: 'user', content: [{ type: 'text', text: input }] })
    setMessages([...messagesRef.current])
    setError(null)
    setWarn(null)
    setStreamingText('')
    setToolEntries([])
    setActivity({ state: 'thinking' })
    abortRef.current = new AbortController()

    let assistantText = ''
    const localTools: ToolCallEntry[] = []

    try {
      await runLoop(messagesRef.current, input, {
        provider: deps.provider,
        tools: deps.tools,
        logger: deps.logger,
        history: deps.history,
        callbacks: {
          onText: (t) => {
            assistantText += t
            setStreamingText(assistantText)
          },
          onToolStart: (name) => setActivity({ state: 'tool', text: name }),
          onToolResult: (id, _name, r) => {
            // 按 id 精确配对 tool_use（并发结果顺序不定，按名字猜会贴错）
            const lastA = [...messagesRef.current]
              .reverse()
              .find((m) => m.role === 'assistant')
            const tu = lastA?.content.find(
              (b) => b.type === 'tool_use' && (b as ToolUseBlock).id === id,
            ) as ToolUseBlock | undefined
            if (tu && !pairedRef.current.has(id)) {
              pairedRef.current.add(id)
              localTools.push({
                use: tu,
                result: {
                  type: 'tool_result',
                  tool_use_id: id,
                  content: r.content,
                  is_error: r.is_error,
                },
              })
              setToolEntries([...localTools])
            }
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
      // commit：messages 进 Static，清动态区
      setMessages([...messagesRef.current])
      setStreamingText(null)
      setToolEntries([])
      setActivity({ state: 'idle' })
    } catch (e) {
      // 中断/错误：固化已生成内容
      setMessages([...messagesRef.current])
      setStreamingText(null)
      setToolEntries([])
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

  // Ctrl+O：全部展开/折叠当前轮工具输出（放弃 Tab 焦点交互）
  useInput((input, key) => {
    if (key.ctrl && input === 'o') {
      setExpandAll((v) => !v)
    }
  })

  const items = useMemo(
    () => [
      ...messagesToItems(messages, expandAll),
      ...systemMsgs.map((m, i) => <AssistantMessage key={`sys${i}`} text={m} />),
    ],
    [messages, systemMsgs, expandAll],
  )
  const busy =
    streamingText !== null ||
    activity.state === 'thinking' ||
    activity.state === 'tool' ||
    activity.state === 'retry'

  return (
    <App
      key={clearKey}
      model={deps.cfg.model}
      items={items}
      streamingText={streamingText}
      toolEntries={toolEntries}
      activity={activity.state}
      activityText={activity.text}
      tokens={tokens}
      iter={iter}
      maxIter={maxIter}
      warning={warning ?? warn ?? undefined}
      expandedAll={expandAll}
    >
      {error ? <ErrorBanner error={error} /> : null}
      <InputStream
        onSubmit={submit}
        onCommand={(_cmd, result) => {
          // 替换（不累积）：多次 /help 只显示最新一次，避免反复打印
          setSystemMsgs(result.output ? [result.output as string] : [])
        }}
        onClear={() => {
          messagesRef.current = []
          setMessages([])
          setSystemMsgs([])
          setTokens(0)
          setIter(undefined)
          setMaxIter(undefined)
          setWarn(null)
          setError(null)
          setExpandAll(false)
          // remount App（重置 <Static> 的内部 index，避免 /clear 后消息不渲染）
          setClearKey((k) => k + 1)
        }}
        placeholder={busy ? '（处理中，Ctrl+C 中断）...' : '输入消息，/help 查看命令...'}
      />
    </App>
  )
}
