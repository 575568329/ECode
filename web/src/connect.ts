/**
 * M13-W5 连接工程：mux 流连接（fetch + eventsource-parser）+ 命令 POST + 鉴权存储。
 *
 * 设计依据（方案 §4 + Web 技术栈调研）：
 * - 不用 EventSource——不能带 Authorization header；token 落 URL query 属 OWASP 风险。
 *   token 经 header + localStorage（首访问输入一次）。
 * - 重连：指数退避 500ms×2 封顶 10s + 抖动；3s open timeout（防代理不回）；visibilitychange 回前台立即重连。
 * - 断线恢复：重连成功后触发 onReconnect（App 层对当前会话 session/read 全量补拉——Q10，不做增量补帧）。
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

const TOKEN_KEY = 'ecode-token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}

export interface MuxFrame {
  project: string
  sessionId: string
  ev: { type: string; [k: string]: unknown }
}
export interface HostEventFrame {
  host:
    | { type: 'project/added'; project: string }
    | { type: 'project/removed'; project: string }
    | { type: 'session/created'; brief: { project: string; sessionId: string; running: boolean; title: string; updatedAt: number } }
    | { type: 'session/removed'; project: string; sessionId: string }
    | { type: 'session/baseline'; projects: string[]; sessions: Array<{ project: string; sessionId: string; running: boolean; title: string; updatedAt: number }> }
}

const OPEN_TIMEOUT_MS = 3_000
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

export interface MuxConnection {
  dispose(): void
}

/** 连接 mux 流。onFrame/onHost/onReconnect 全部由调用方装配状态。
 * sessionId：订阅指定会话（缺省=项目默认会话）——serve 只向订阅者推该会话的信封帧，
 * 切会话须带 ?sessionId= 重订（G3 实测：不订则恢复会话的 delta/turn/审批帧全部丢失）。 */
export function connectMux(
  base: string,
  handlers: {
    onFrame?: (f: MuxFrame) => void
    onHost?: (h: HostEventFrame['host']) => void
    onReconnect?: () => void
    onState?: (s: 'connecting' | 'open' | 'backoff') => void
  },
  sessionId?: string,
): MuxConnection {
  let disposed = false
  let attempt = 0
  const abort = new AbortController()
  const muxUrl =
    sessionId !== undefined && sessionId !== ''
      ? `${base}/api/events.mux?sessionId=${encodeURIComponent(sessionId)}`
      : `${base}/api/events.mux`

  const visibilityResume = (): void => {
    if (document.visibilityState === 'visible' && attempt > 0) {
      attempt = 0
      abort.abort()
    }
  }
  document.addEventListener('visibilitychange', visibilityResume)

  const loop = async (): Promise<void> => {
    while (!disposed) {
      try {
        handlers.onState?.('connecting')
        const openTimer = setTimeout(() => abort.abort(), OPEN_TIMEOUT_MS)
        const res = await fetch(muxUrl, {
          headers: { authorization: `Bearer ${getToken()}` },
          signal: abort.signal,
        })
        clearTimeout(openTimer)
        if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)
        const reader = res.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader()
        const wasReconnect = attempt > 0
        attempt = 0
        handlers.onState?.('open')
        if (wasReconnect) handlers.onReconnect?.()
        for (;;) {
          const chunk = await reader.read()
          const value = chunk.value as { event?: string; data?: string } | undefined
          if (chunk.done || disposed) break
          if (value === undefined || value.data === undefined) continue // 注释/心跳行无 data
          try {
            const parsed = JSON.parse(value.data) as MuxFrame | HostEventFrame
            if ('host' in parsed) handlers.onHost?.(parsed.host)
            else handlers.onFrame?.(parsed)
          } catch {
            /* 非 JSON 行跳过 */
          }
        }
      } catch {
        if (disposed) break
      }
      if (disposed) break
      // 退避：500ms×2^n 封顶 10s + 抖动（harness connection.ts 同款参数）
      handlers.onState?.('backoff')
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 5)) * (0.7 + Math.random() * 0.6)
      attempt++
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  void loop()

  return {
    dispose() {
      disposed = true
      document.removeEventListener('visibilitychange', visibilityResume)
      abort.abort()
    },
  }
}

/** 发命令（信封形态——W5 起统一走信封；回执带 sessionId）。 */
export async function sendCommand(
  base: string,
  project: string,
  sessionId: string | undefined,
  op: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; sessionId?: string; value?: unknown; [k: string]: unknown }> {
  const body: Record<string, unknown> = { op }
  if (sessionId !== undefined && sessionId !== '') body.sessionId = sessionId
  const res = await fetch(`${base}/api/p/${encodeURIComponent(project)}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new Error('未授权——请检查 token')
  return (await res.json()) as { ok: boolean }
}

/** 项目列表（三源并集）。 */
export async function fetchProjects(
  base: string,
): Promise<{ registered: Array<{ path: string }>; active: Array<{ path: string }>; history: string[] }> {
  const res = await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!res.ok) throw new Error(`projects HTTP ${res.status}`)
  return (await res.json()) as { registered: Array<{ path: string }>; active: Array<{ path: string }>; history: string[] }
}
