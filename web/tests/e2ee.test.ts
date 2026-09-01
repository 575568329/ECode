/**
 * R3 E2EE 跨实现契约测试：WebCrypto 侧（web/src/e2ee.ts）↔ Node 侧（src/server/e2ee.ts）。
 * 契约=线格式逐字节兼容：握手帧互认、密文帧互解、重放双侧同拒。
 * （Node 22 的 WebCrypto 含 X25519——真浏览器形态同走这一套 API。）
 */
import { describe, expect, it } from 'vitest'
import { E2eeHostSession, generateKeypair } from '../../src/server/e2ee.js'
import { WebE2eeSession, ensureX25519Supported } from '../src/e2ee'

const HOST_AUTH = 'dev-secret-web'

async function handshake(): Promise<{ host: E2eeHostSession; web: WebE2eeSession }> {
  const keys = generateKeypair()
  const host = new E2eeHostSession(keys.privateKeyB64, (s) => (s === HOST_AUTH ? 'device' : null))
  const web = new WebE2eeSession(keys.publicKeyB64, HOST_AUTH)
  const hello = await web.startHello()
  const r1 = host.onHandshake(hello)
  expect(r1.send).toBeDefined() // e2ee_ready（明文）
  const r2 = await web.onHandshakeFrame(r1.send!)
  expect(r2.send).toBeDefined() // enc e2ee_auth（WebCrypto 加密）
  const r3 = host.onHandshake(r2.send!) // Node 侧解密验凭据
  expect(r3.ready).toBe(true)
  expect(r3.send).toBeDefined() // enc e2ee_ok（Node 加密）
  const r4 = await web.onHandshakeFrame(r3.send!)
  expect(r4.ready).toBe(true) // WebCrypto 解密 e2ee_ok
  return { host, web }
}

describe('E2EE 契约（WebCrypto ↔ Node）', () => {
  it('X25519 能力可用（Node WebCrypto）', async () => {
    await expect(ensureX25519Supported()).resolves.toBeUndefined()
  })

  it('全握手跨实现互认', async () => {
    const { host, web } = await handshake()
    expect(host.readyState).toBe(true)
    expect(web.readyState).toBe(true)
  })

  it('web 加密 → host 解；host 加密 → web 解（双向线格式兼容）', async () => {
    const { host, web } = await handshake()
    const w = await web.encode({ t: 'cmd', id: 'q1', body: { op: { op: 'session/list' } } })
    expect((host.decode(w) as { t: string }).t).toBe('cmd')
    const n = host.encode({ t: 'res', id: 'q1', json: { ok: true, value: [] } })
    expect((await web.decode(n))?.t).toBe('res')
    // 连续多帧（计数器双端独立递进）
    expect((host.decode(await web.encode({ t: 'cmd', id: 'q2' })) as { id: string }).id).toBe('q2')
  })

  it('重放拒绝（web→host 方向）', async () => {
    const { host, web } = await handshake()
    const f = await web.encode({ t: 'cmd', id: 'q1' })
    expect(host.decode(f)).not.toBeNull()
    expect(host.decode(f)).toBeNull()
  })

  it('坏凭据：host 拒 auth（4001）', async () => {
    const keys = generateKeypair()
    const host = new E2eeHostSession(keys.privateKeyB64, () => null)
    const web = new WebE2eeSession(keys.publicKeyB64, HOST_AUTH)
    const r1 = host.onHandshake(await web.startHello())
    const r2 = await web.onHandshakeFrame(r1.send!)
    const r3 = host.onHandshake(r2.send!)
    expect(r3.close?.code).toBe(4001)
  })
})
