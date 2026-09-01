/**
 * R2/R3 审阅修复回归：web/src/relay.ts 安全语义（该文件此前整文件零测试——测试席 P1-8）。
 * stub 全局（localStorage/document/WebSocket）后动态 import——覆盖：
 * - #pairing 深链解析（合法 offer 落配置 / 坏链不落）
 * - 缺 daemonPubKeyB64（D4 强制面）→ 拒连+清凭据+lost 提示
 * - WS close 4401（吊销）→ 清凭据+unauthorized（回配对流语义）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RelayModule = typeof import('../src/relay')

// —— 全局 stub（relay.ts 模块加载即触 document.addEventListener；WebSocket 在连接时实例化）——
class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(public url: string, public protocols?: string[]) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  // 测试驱动
  fireOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }
  fireClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  FakeWebSocket.instances = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  })
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' })
  vi.stubGlobal('location', { hash: '', pathname: '/', search: '' })
  vi.stubGlobal('history', {
    replaceState: (_a: unknown, _b: unknown, url: string) => {
      ;(globalThis.location as unknown as { hash: string }).hash = new URL(url, 'http://x').hash
    },
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadRelay(): Promise<RelayModule> {
  return await import('../src/relay')
}

describe('web relay 安全语义', () => {
  it('consumePairingHash：合法 offer（带 relay 段+公钥）落配置+token，剥 hash', async () => {
    const relay = await loadRelay()
    const offer = {
      secret: 'dev-secret',
      name: '公司电脑',
      projects: ['D:/work/proj'],
      relay: { connectUrl: 'wss://r.example/ecode/v1/connect/h1', hostId: 'h1', inviteToken: 'inv-1234567890123456', expiresAt: 0 },
      daemonPubKeyB64: 'PUBKEY',
    }
    const b64 = Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url')
    ;(globalThis.location as unknown as { hash: string }).hash = `#pairing=${b64}`
    relay.consumePairingHash()
    const cfg = relay.relayGetCfg()
    expect(cfg).not.toBeNull()
    expect(cfg?.daemonPubKeyB64).toBe('PUBKEY')
    expect(cfg?.hostId).toBe('h1')
    expect(relay.relayActive()).toBe(true)
    expect(storage.get('ecode-token')).toBe('dev-secret')
    expect((globalThis.location as unknown as { hash: string }).hash).toBe('')
  })

  it('consumePairingHash：坏链/无 relay 段不落配置', async () => {
    const relay = await loadRelay()
    ;(globalThis.location as unknown as { hash: string }).hash = '#pairing=!!!not-base64!!!'
    relay.consumePairingHash()
    expect(relay.relayGetCfg()).toBeNull()
    // 无 relay 段（局域网形态）——不落 relay 配置
    const offer = { secret: 's1' }
    const b64 = Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url')
    ;(globalThis.location as unknown as { hash: string }).hash = `#pairing=${b64}`
    relay.consumePairingHash()
    expect(relay.relayGetCfg()).toBeNull()
  })

  it('缺 daemonPubKeyB64（D4 强制面）：连接被拒+凭据全清+lost 提示', async () => {
    const relay = await loadRelay()
    relay.relaySetCfg({ connectUrl: 'wss://r.example/x', inviteToken: 'inv-1234567890123456', secret: 'sec', hostId: 'h1' })
    storage.set('ecode-token', 'sec')
    void relay.relaySendCommand('p', undefined, { op: { op: 'session/list' } }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(storage.has('ecode-token')).toBe(false)
    expect(relay.relayGetCfg()).toBeNull()
    expect(relay.relayLostMessage()).toContain('端到端加密公钥')
  })

  it('WS close 4401（吊销）：清凭据+lost 提示——不再无限重连（回配对流语义）', async () => {
    const relay = await loadRelay()
    relay.relaySetCfg({ connectUrl: 'wss://r.example/x', inviteToken: 'inv-1234567890123456', secret: 'sec', hostId: 'h1', daemonPubKeyB64: 'PUBKEY' })
    storage.set('ecode-token', 'sec')
    let unauthorized = false
    relay
      .relayConnectMux({ onUnauthorized: () => (unauthorized = true) }, undefined, () => null)
      .dispose.toString() // 挂载连接（dispose 不立即调——保持 WS 活）
    await new Promise((r) => setTimeout(r, 30))
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0)
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 20))
    ws.fireClose(4401, 'invite revoked')
    await new Promise((r) => setTimeout(r, 20))
    expect(storage.has('ecode-token')).toBe(false)
    expect(relay.relayGetCfg()).toBeNull()
    expect(relay.relayLostMessage()).toContain('失效')
    expect(unauthorized).toBe(true)
  })

  it('解密失败 fail-close：ws.close(4003) 主动断腿（严格计数器语义）', async () => {
    const relay = await loadRelay()
    relay.relaySetCfg({ connectUrl: 'wss://r.example/x', inviteToken: 'inv-1234567890123456', secret: 'sec', hostId: 'h1', daemonPubKeyB64: 'PUBKEY' })
    relay.relayConnectMux({}, undefined, () => null)
    await new Promise((r) => setTimeout(r, 30))
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws.fireOpen()
    await new Promise((r) => setTimeout(r, 20))
    // ready 前收到非握手帧（e2ee 状态机会 throw→close）——模拟握手损坏
    ws.onmessage?.({ data: 'garbage-not-json' })
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.readyState).toBe(3) // 已关
  })
})
