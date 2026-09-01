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
import { relayActive, relaySendCommand, relayConnectMux, relayFetchProjects, relayAddProject, relayFetchStats } from './relay'

const TOKEN_KEY = 'ecode-token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}
/** 401 时清除失效凭据（App 层收到 onUnauthorized 后回 token 门重输——G3 挂账缺陷修复） */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
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
 * sessionId 参数已废弃（服务端全量广播语义，参数被有意忽略——审阅 P1-5 注释改真；
 * 保留签名兼容调用方）。M14 配对设备在此接 per-device 过滤。 */
export function connectMux(
  base: string,
  handlers: {
    onFrame?: (f: MuxFrame) => void
    onHost?: (h: HostEventFrame['host']) => void
    onReconnect?: () => void
    onState?: (s: 'connecting' | 'open' | 'backoff') => void
    /** 401：token 已清除（clearToken），调用方应回 token 门重输——不再退避重试（G3 挂账缺陷修复） */
    onUnauthorized?: () => void
  },
  sessionId?: string,
  /** W-9（批 4）：断线游标——每次连接尝试时读取；返回数字则 mux 重放该会话缓冲帧（seq>since） */
  sinceSeq?: () => number | null,
): MuxConnection {
  // R2：中继形态——同契约 WS 数据腿（过滤/重放/重连语义 daemon 侧原样承担）
  if (relayActive()) return relayConnectMux(handlers as Parameters<typeof relayConnectMux>[0], sessionId, sinceSeq)
  let disposed = false
  let attempt = 0
  const buildMuxUrl = (): string => {
    const params = new URLSearchParams()
    if (sessionId !== undefined && sessionId !== '') params.set('sessionId', sessionId)
    params.set('canAnswer', '1')
    const since = sinceSeq?.() ?? null
    if (since !== null && Number.isFinite(since)) params.set('sinceSeq', String(since))
    return `${base}api/events.mux?${params.toString()}`
  }

  // 每个 connectMux 实例一个 controller；loop 每次迭代重建（审阅 P0-2：曾整个循环共用
  // 一个——visibilityResume abort 一次后永久废弃，此后每次 fetch 立即 AbortError=
  // 手机切后台回前台永久断连只靠手动刷新）
  let openAbort: AbortController | null = null

  const visibilityResume = (): void => {
    if (document.visibilityState === 'visible' && attempt > 0) {
      attempt = 0
      openAbort?.abort()
    }
  }
  document.addEventListener('visibilitychange', visibilityResume)

  const loop = async (): Promise<void> => {
    while (!disposed) {
      openAbort = new AbortController()
      try {
        handlers.onState?.('connecting')
        const openTimer = setTimeout(() => openAbort?.abort(), OPEN_TIMEOUT_MS)
        const res = await fetch(buildMuxUrl(), {
          headers: { authorization: `Bearer ${getToken()}` },
          signal: openAbort.signal,
        })
        clearTimeout(openTimer)
        if (res.status === 401) {
          // token 失效：清凭据 + 上报后终止循环——退避重试 401 只会永远死循环（G3 实测）
          clearToken()
          disposed = true
          handlers.onUnauthorized?.()
          break
        }
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
      openAbort?.abort()
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
  if (relayActive()) return relaySendCommand(project, sessionId, op)
  const body: Record<string, unknown> = { op }
  if (sessionId !== undefined && sessionId !== '') body.sessionId = sessionId
  // confirm=true：web 每条命令都源自用户显式交互（点项目/发送）＝栅栏要求的二次确认语义
  // 本身；不带则历史反推项目首拉 428（命令静默失败——列表空死的根因）
  const res = await fetch(`${base}api/p/${encodeURIComponent(project)}/cmd?confirm=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    clearToken() // 命令通道 401 同样清凭据——App 的 mux onUnauthorized 会回 token 门
    throw new Error('未授权——token 已失效，请重新输入')
  }
  return (await res.json()) as { ok: boolean }
}

/** 项目列表（三源并集）。 */
export async function fetchProjects(
  base: string,
): Promise<{ registered: Array<{ path: string }>; active: Array<{ path: string }>; history: string[] }> {
  // R2：中继形态——device 凭据不可枚举项目（403 栅栏），用配对时刻快照
  if (relayActive()) return relayFetchProjects()
  const res = await fetch(`${base}api/projects`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (res.status === 401) {
    clearToken()
    throw new Error('未授权——token 已失效，请重新输入')
  }
  if (!res.ok) throw new Error(`projects HTTP ${res.status}`)
  return (await res.json()) as { registered: Array<{ path: string }>; active: Array<{ path: string }>; history: string[] }
}

/** 用量统计（M14-C4④）：/api/stats 聚合（days 过滤 byDay 尾部窗口） */
export interface StatsPayload {
  days: number
  totals: { input: number; output: number; cacheRead: number; cacheCreation: number; costCny: number }
  mcpCalls: number
  sessions: number
  costUnknownSessions: number
  cacheHitRate: number
  byDay: Array<{ date: string; sessions: number; input: number; output: number; costCny: number; mcpCalls: number }>
  byModel: Array<{ model: string; input: number; output: number; costCny: number }>
  byProject: Array<{ project: string; input: number; output: number; costCny: number; mcpCalls: number }>
}
export async function fetchStats(base: string, days = 7): Promise<StatsPayload> {
  if (relayActive()) return relayFetchStats()
  const res = await fetch(`${base}api/stats?days=${days}`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (res.status === 401) {
    clearToken()
    throw new Error('未授权——token 已失效，请重新输入')
  }
  if (!res.ok) throw new Error(`stats HTTP ${res.status}`)
  const r = (await res.json()) as StatsPayload & { ok?: boolean; error?: string }
  if (r.ok === false) throw new Error(String(r.error ?? '统计不可用'))
  return r
}

/** 添加项目（web 侧栏「+」）：注册入列表（不冷起宿主）；返回规范化路径（导航 /api/p/<path> 须用它）。 */
export async function addProject(base: string, path: string): Promise<string> {
  if (relayActive()) return relayAddProject()
  const res = await fetch(`${base}api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path }),
  })
  if (res.status === 401) {
    clearToken()
    throw new Error('未授权——token 已失效，请重新输入')
  }
  const r = (await res.json()) as { ok: boolean; path?: string; error?: string }
  if (!r.ok || r.path === undefined) throw new Error(r.error ?? `添加失败 HTTP ${res.status}`)
  return r.path
}
