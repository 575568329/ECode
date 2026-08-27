/**
 * M12-B7：HTTP 客户端 transport（与 InMemoryChannel 同契约——ClientTransport 接口的网络实现）。
 * spike 客户端转正：SSE 解析 reader 循环外取一次（锁定流再 getReader 会静默抛——spike 实测坑）。
 */

import type { ClientTransport } from './channel.js'
import type { CommandResult, ProtocolCommand, ProtocolEvent } from './types.js'
import type { EventHandler } from './channel.js'

export class HttpTransport implements ClientTransport {
  private readonly handlers = new Set<EventHandler>()
  private aborted = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
  }

  async send(cmd: ProtocolCommand): Promise<CommandResult> {
    if (this.aborted) return { ok: false, error: '通道已销毁', code: 'DISPOSED' }
    try {
      const res = await fetch(`${this.baseUrl}/api/cmd`, {
        method: 'POST',
        headers: this.headers,
        // 裸 ProtocolCommand——本 transport 与单会话 serveHost（/api/cmd）配对；multi 的
        // 信封路由由 web/feishu 各自的连接层负责（审阅 B2 后两服务形态并存、契约各自明确）
        body: JSON.stringify(cmd),
      })
      return (await res.json()) as CommandResult
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'NETWORK' }
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    if (this.reconnectTimer === null && !this.aborted) void this.pump()
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** SSE 拉流 + 断线重连（指数退避 1s→10s；重连后订阅即重放 pending 由服务端负责） */
  private async pump(): Promise<void> {
    let backoff = 1000
    while (!this.aborted && this.handlers.size > 0) {
      try {
        const res = await fetch(`${this.baseUrl}/api/events`, { headers: this.headers })
        if (res.status === 401) {
          // 鉴权失败重连无意义（token 错不会自愈）——通知订阅者并停止泵
          for (const h of [...this.handlers]) h({ type: 'error', seq: -1, message: 'SSE 401：token 无效或已轮换' } as never)
          this.aborted = true
          return
        }
        if (!res.ok || res.body === null) throw new Error(`SSE ${res.status}`)
        backoff = 1000
        const reader = res.body.getReader() // 循环外取一次（锁定流再取会抛）
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                const ev = JSON.parse(line.slice(6)) as ProtocolEvent
                for (const h of [...this.handlers]) h(ev)
              }
            }
          }
        }
      } catch {
      /* 断线 → 退避重连 */
      }
      if (this.aborted || this.handlers.size === 0) break
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 10_000)
    }
  }

  dispose(): void {
    this.aborted = true
    this.handlers.clear()
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
  }
}
