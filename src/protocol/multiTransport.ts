/**
 * T 线 T4：附着形态的客户端传输——multi 信封（M13 架构）的 Node 端 ClientTransport 实现。
 *
 * 与 HttpTransport（M12-B7，单会话 serveHost 裸命令+已退役 /api/events）的分工：本类是
 * TuiApp 附着 daemon 的正规通道——命令 POST /api/p/{project}/cmd（信封带 sessionId），事件
 * GET /api/events.mux（全量广播+本地按 sessionId 分发，切会话零重连——web connect.ts 同构）。
 *
 * 断线恢复（W-9）：跟踪本会话帧 seq，重连带 sinceSeq 重放缓冲；宿主 gap=true（缓冲覆盖不到）
 * 时回调 onGap 由客户端 session/read 全量补同步。蓝本：web/src/connect.ts + spike 实测
 * （SSE reader 循环外取一次；401 停泵不退避）。
 */

import { appendFileSync } from 'node:fs'
import type { ClientTransport, EventHandler } from './channel.js'
import type { CommandResult, ProtocolCommand, ProtocolEvent } from './types.js'

const OPEN_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

interface MuxSseFrame {
  project: string
  sessionId: string
  ev: { type: string; seq?: number; [k: string]: unknown }
  host?: { type: string }
}

export interface MultiTransportOpts {
  baseUrl: string
  token: string
  project: string
  /** 当前会话 id（切会话由调用方更新；事件按它分发、命令逐条入信封） */
  getSessionId: () => string | undefined
  /** TUI 可应答审批（canAnswer=1 计入 fail-closed 判定——C2⑧） */
  canAnswer?: boolean
  /** 重连成功（含首连）；gap 时调用方应全量补同步（session/read） */
  onReconnect?: (gap: boolean) => void
  /** 401：token 失效，调用方回凭据处理（不退避重试） */
  onUnauthorized?: () => void
  /** 连接状态（附着态顶栏 daemon 标识消费） */
  onState?: (s: 'connecting' | 'open' | 'backoff') => void
}

export class MultiTransport implements ClientTransport {
  private readonly handlers = new Set<EventHandler>()
  private aborted = false
  /** 重连触发补拉旗标（首连不触发——宿主 restore 时本就全量拉） */
  private everConnected = false
  private lastSeq: number | null = null
  private abort: AbortController | null = null
  private pumpStarted = false
  private sessionId: string | undefined
  private state: 'connecting' | 'open' | 'backoff' = 'connecting'

  constructor(private readonly opts: MultiTransportOpts) {}

  /** 更新当前会话 id（切会话零重连——事件全量广播+本地分发，web 同构） */
  setSessionId(sid: string): void {
    this.sessionId = sid
    this.lastSeq = null // 新会话无游标——gap 判定重来
  }

  /** T5（D-T3 增补）：连接状态（TUI 顶栏「后台运行中/重连中」标识的数据源） */
  daemonState(): 'connecting' | 'open' | 'backoff' {
    return this.state
  }

  async send(cmd: ProtocolCommand): Promise<CommandResult> {
    if (this.aborted) return { ok: false, error: '通道已销毁', code: 'DISPOSED' }
    try {
      const body: Record<string, unknown> = { op: cmd as unknown as Record<string, unknown> } // multi 信封：body.op=完整命令对象（multi.ts 拆 .op 字段路由）
      const sid = this.sessionId ?? this.opts.getSessionId()
      if (sid !== undefined && sid !== '') body.sessionId = sid
      // confirm=true：TUI 每条命令同源自用户显式交互（Enter/按键）＝历史反推项目 428 栅栏的确认语义
      const res = await fetch(`${this.opts.baseUrl}/api/p/${encodeURIComponent(this.opts.project)}/cmd?confirm=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(body),
      })
      if (res.status === 401) {
        this.opts.onUnauthorized?.()
        return { ok: false, error: '未授权：token 无效或已轮换', code: 'UNAUTHORIZED' }
      }
      return (await res.json()) as CommandResult
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'NETWORK' }
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    if (!this.pumpStarted && !this.aborted) {
      this.pumpStarted = true
      void this.pump()
    }
    return () => {
      this.handlers.delete(handler)
    }
  }

  dispose(): void {
    this.aborted = true
    this.abort?.abort()
    this.handlers.clear()
  }

  /** SSE 拉流主循环（指数退避重连；sinceSeq 游标续传；gap→onGap 全量补同步） */
  private async pump(): Promise<void> {
    let backoff = BACKOFF_BASE_MS
    while (!this.aborted && this.handlers.size > 0) {
      this.state = 'connecting'
      this.opts.onState?.('connecting')
      this.abort = new AbortController()
      try {
        const params = new URLSearchParams()
        params.set('canAnswer', this.opts.canAnswer === false ? '0' : '1')
        const since = this.lastSeq
        if (since !== null && Number.isFinite(since)) params.set('sinceSeq', String(since))
        // 3s open timeout（web 同款：防代理不回挂死）
        const openTimer = setTimeout(() => this.abort?.abort(), OPEN_TIMEOUT_MS)
        const res = await fetch(`${this.opts.baseUrl}/api/events.mux?${params.toString()}`, {
          headers: { authorization: `Bearer ${this.opts.token}`, accept: 'text/event-stream' },
          signal: this.abort.signal,
        })
        clearTimeout(openTimer)
        if (res.status === 401) {
          this.opts.onUnauthorized?.()
          this.aborted = true
          return
        }
        if (!res.ok || res.body === null) throw new Error(`mux SSE ${res.status}`)
        this.state = 'open'
        this.opts.onState?.('open')
        const gap = this.everConnected // 重连=补拉旗标（是否 gap 由 subscribed 帧精确判定，此为保守估计）
        this.everConnected = true
        backoff = BACKOFF_BASE_MS
        // spike 实测坑：reader 循环外取一次（锁定流再 getReader 抛 TypeError）
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (!this.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of raw.split('\n')) {
              if (!line.startsWith('data: ')) continue
              const frame = JSON.parse(line.slice(6)) as MuxSseFrame
              this.handleFrame(frame, gap)
            }
          }
        }
      } catch {
        // 断线——退避重连（abort 静默）
      }
      if (this.aborted || this.handlers.size === 0) return
      this.state = 'backoff'
      this.opts.onState?.('backoff')
      await new Promise((r) => setTimeout(r, backoff * (0.5 + Math.random())))
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  /** mux 帧→客户端事件：只分发当前会话的 ev（全量广播本地过滤——切会话零重连） */
  private handleFrame(frame: MuxSseFrame, reconnected: boolean): void {
    try { appendFileSync('D:/study/ECode/.ecode/mt-frames.log', `frame ${frame.sessionId} ${frame.ev?.type}
`) } catch {}
    if (process.env.ECODE_DBG) console.error('[DBG mt] raw frame sid=', frame.sessionId, 'mine=', frame.sessionId === (this.sessionId ?? this.opts.getSessionId()))
    if ('host' in frame && frame.host !== undefined) return // 宿主生命周期帧（列表变化走 session/list 主动拉）
    const sid = this.sessionId ?? this.opts.getSessionId()
    if (frame.sessionId !== sid) return
    const ev = frame.ev as unknown as ProtocolEvent
    if (ev.type === 'session/subscribed') {
      // W-9：重放基线——gap=true（缓冲覆盖不到）通知全量补同步
      const gapFlag = (ev as unknown as { gap?: boolean }).gap === true
      if (reconnected && gapFlag) {
        this.lastSeq = null
        this.opts.onReconnect?.(true)
      }
      return
    }
    if (process.env.ECODE_DBG) console.error('[DBG mt] frame', frame.sessionId, ev.type, 'mine=', frame.sessionId === sid)
    const seq = (ev as unknown as { seq?: number }).seq
    if (typeof seq === 'number' && Number.isFinite(seq)) this.lastSeq = seq
    for (const h of [...this.handlers]) h(ev)
  }
}
