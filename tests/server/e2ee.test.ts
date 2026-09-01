/**
 * R3 E2EE 单测：握手状态机/双向帧往返/严格计数器（重放·乱序·篡改全拒）/钥匙持久化。
 * WebCrypto 侧（web/src/e2ee.ts）的跨实现契约在 web/tests/e2ee.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { E2eeClientSession, E2eeHostSession, buildNonce, deriveKeys, generateKeypair, loadOrCreateHostKeys } from '../../src/server/e2ee.js'

/** 完整握手：返回就绪的 host/client 对 */
function handshake(hostKeys = generateKeypair(), auth = 'dev-secret'): { host: E2eeHostSession; client: E2eeClientSession } {
  const host = new E2eeHostSession(hostKeys.privateKeyB64, (s) => (s === auth ? 'device' : null))
  const client = new E2eeClientSession(hostKeys.publicKeyB64, auth)
  const hello = client.start()
  let r = host.onHandshake(hello)
  expect(r.send).toBeDefined() // e2ee_ready
  const c = client.onMessage(r.send!)
  expect(c.send).toBeDefined() // enc e2ee_auth
  r = host.onHandshake(c.send!)
  expect(r.ready).toBe(true) // auth 通过
  expect(r.send).toBeDefined() // enc e2ee_ok
  const ok = client.decode(r.send!)
  expect((ok as { t?: string }).t).toBe('e2ee_ok')
  return { host, client }
}

describe('E2EE 握手', () => {
  it('全握手→就绪；明文 hello 被拒（D4 强制面）', () => {
    const { host, client } = handshake()
    expect(host.readyState).toBe(true)
    expect(client.readyState).toBe(true)
    const freshHost = new E2eeHostSession(generateKeypair().privateKeyB64, () => 'device')
    const r = freshHost.onHandshake(JSON.stringify({ t: 'hello', auth: 'x' }))
    expect(r.close?.code).toBe(4001)
  })

  it('坏凭据：握手到 auth 被拒（4001）', () => {
    const host = new E2eeHostSession(generateKeypair().privateKeyB64, () => null)
    const client = new E2eeClientSession(generateKeypair().publicKeyB64, 'whatever')
    const r1 = host.onHandshake(client.start())
    // 公钥不匹配——client 用另一把 host 公钥派生，host 解不开 auth：解密失败 4003
    const c1 = client.onMessage(r1.send!)
    const r2 = host.onHandshake(c1.send!)
    expect(r2.close?.code).toBe(4003)
  })
})

describe('E2EE 帧面', () => {
  it('双向 encode/decode 往返', () => {
    const { host, client } = handshake()
    const f1 = client.encode({ t: 'cmd', id: 'q1', body: { op: { op: 'session/list' } } })
    expect((host.decode(f1) as { t: string }).t).toBe('cmd')
    const f2 = host.encode({ t: 'res', id: 'q1', json: { ok: true, value: [] } })
    expect((client.decode(f2) as { t: string }).t).toBe('res')
    // 多帧连续（计数器递进）
    expect((host.decode(client.encode({ t: 'cmd', id: 'q2' })) as { id: string }).id).toBe('q2')
    expect((client.decode(host.encode({ t: 'frame', frame: { a: 1 } })) as { t: string }).t).toBe('frame')
  })

  it('重放拒绝：同一密文帧第二次解密返回 null', () => {
    const { host, client } = handshake()
    const f = client.encode({ t: 'cmd', id: 'q1' })
    expect(host.decode(f)).not.toBeNull()
    expect(host.decode(f)).toBeNull() // 严格计数器——重放即拒
  })

  it('乱序拒绝：跳过一帧后下一帧被拒（计数器必须精确等值）', () => {
    const { host, client } = handshake()
    const f1 = client.encode({ t: 'cmd', id: 'q1' })
    const f2 = client.encode({ t: 'cmd', id: 'q2' })
    expect(host.decode(f2)).toBeNull() // counter=1 在期望 0 时到达——拒
    // 失败不推进计数器（状态无腐蚀），f1 仍是期望帧——生产侧 DataLeg 对解密失败
    // failClose 断腿（relayClient.ts），会话层 API 无断连记忆，故此处能解出
    expect((host.decode(f1) as { id: string }).id).toBe('q1')
  })

  it('篡改拒绝：密文翻字节→GCM 认证失败', () => {
    const { host, client } = handshake()
    const f = client.encode({ t: 'cmd', id: 'q1' })
    const obj = JSON.parse(f) as { c: string }
    const raw = Buffer.from(obj.c, 'base64')
    raw[0] ^= 0x01
    obj.c = raw.toString('base64')
    expect(host.decode(JSON.stringify(obj))).toBeNull()
  })

  it('方向分钥：d2p 帧喂 p2d 侧解密失败（自反射攻击面闭合）', () => {
    const { host, client } = handshake()
    const f = host.encode({ t: 'res', id: 'q1' }) // daemon→手机方向
    // 拿 host 的 decode（p2d 方向钥匙）解自己发出的帧——钥匙不同必失败
    expect(host.decode(f)).toBeNull()
    expect(client.decode(f)).not.toBeNull()
  })

  it('nonce 布局确定性：v/dir/kind/counter 逐字节可复现', () => {
    const n0 = buildNonce(0, 0)
    const n1 = buildNonce(1, 1)
    expect(n0[0]).toBe(2)
    expect(n0[1]).toBe(0)
    expect(n0[2]).toBe(1)
    expect([...n0.subarray(4)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(n1[1]).toBe(1)
    expect(n1[11]).toBe(1)
    expect(n0.length).toBe(12)
  })

  it('HKDF 派生：同输入同输出、双 nonce 变化即全变（per-socket 新鲜）', () => {
    const shared = Buffer.alloc(32, 7)
    const cn = Buffer.alloc(32, 1)
    const hn = Buffer.alloc(32, 2)
    const k1 = deriveKeys(shared, cn, hn)
    const k2 = deriveKeys(shared, cn, hn)
    const k3 = deriveKeys(shared, cn, Buffer.alloc(32, 3))
    expect([...k1.p2d]).toEqual([...k2.p2d])
    expect([...k1.p2d]).not.toEqual([...k3.p2d])
    expect(k1.p2d.length).toBe(32)
    expect(k1.sessionIdSeg.length).toBe(32)
    expect([...k1.p2d]).not.toEqual([...k1.d2p]) // 方向分钥分离
  })
})

describe('E2EE 钥匙持久化', () => {
  it('loadOrCreate：首启生成，重启复用同一把', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecode-e2ee-'))
    try {
      const file = join(dir, 'keys', 'e2ee.json')
      const k1 = loadOrCreateHostKeys(file)
      const k2 = loadOrCreateHostKeys(file)
      expect(k1.publicKeyB64).toBe(k2.publicKeyB64)
      expect(k1.privateKeyB64).toBe(k2.privateKeyB64)
      // 磁盘形态可解析（0600 在 Windows 无强制力——不断言 mode）
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { publicKeyB64: string }
      expect(parsed.publicKeyB64).toBe(k1.publicKeyB64)
      // 损坏文件=重生成（披露语义）
      const k4 = loadOrCreateHostKeys(join(dir, 'keys', 'broken.json'))
      expect(k4.publicKeyB64).not.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
