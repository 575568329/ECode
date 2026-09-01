/**
 * R3：web 侧 E2EE（WebCrypto X25519+HKDF-SHA256+AES-256-GCM——与 src/server/e2ee.ts 同契约）。
 *
 * 对齐面（两端逐字段一致，契约测试锁定）：
 * - 派生：HKDF(ikm=X25519(eph, hostStatic), salt='ecode-e2ee-v2'||clientNonce||hostNonce, info='keys', 96B)
 *   → p2d[0:32] / d2p[32:64] / sessionIdSeg[64:96]；
 * - nonce 12B 确定性布局：v=2 || dir(0=p2d,1=d2p) || kind=1 || pad || counter(u64BE)；
 * - AAD = sessionIdSeg || nonce；GCM tag 128bit；接收侧严格递增计数器（错位即失败）。
 *
 * 浏览器要求：Chrome 133+ / Safari 18.4+ 的 WebCrypto 才有 X25519——不支持时给出明确报错
 * （relayed 连接 D4 强制加密，无明文回退）。
 */

export const E2EE_VERSION = 2
const NONCE_LEN = 12
const DIR_P2D = 0
const DIR_D2P = 1

function b64encode(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (s === undefined) throw new Error('此环境无 WebCrypto——无法建立端到端加密')
  return s
}

/** X25519 能力探测（首次配对/连接时调用一次；不支持=明确指引换新浏览器） */
export async function ensureX25519Supported(): Promise<void> {
  try {
    const zeros = new Uint8Array(new ArrayBuffer(32))
    await subtle().importKey('raw', zeros, 'X25519', false, [])
  } catch (e) {
    throw new Error(`此浏览器不支持端到端加密所需的 X25519（需 Chrome 133+/Safari 18.4+）：${e instanceof Error ? e.message : String(e)}`)
  }
}

function buildNonce(dir: number, counter: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(new ArrayBuffer(NONCE_LEN))
  const counterBig = BigInt(counter)
  n[0] = E2EE_VERSION
  n[1] = dir
  n[2] = 1 // kind=data
  n[3] = 0
  for (let i = 0; i < 8; i++) n[4 + i] = Number((counterBig >> BigInt(8 * (7 - i))) & 0xffn)
  return n
}

interface DerivedKeys {
  p2d: CryptoKey
  d2p: CryptoKey
  sessionIdSeg: Uint8Array
}

async function deriveKeys(shared: ArrayBuffer, clientNonce: Uint8Array<ArrayBuffer>, hostNonce: Uint8Array<ArrayBuffer>): Promise<DerivedKeys> {
  const s = subtle()
  const domain = new TextEncoder().encode('ecode-e2ee-v2')
  const salt = new Uint8Array(domain.length + 64)
  salt.set(domain, 0)
  salt.set(clientNonce, domain.length)
  salt.set(hostNonce, domain.length + 32)
  const ikm = await s.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('keys') }, ikm, 96 * 8))
  const p2d = await s.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const d2p = await s.importKey('raw', okm.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { p2d, d2p, sessionIdSeg: okm.slice(64, 96) }
}

export class WebE2eeSession {
  private state: 'init' | 'wait-ready' | 'wait-ok' | 'ready' = 'init'
  private eph: CryptoKeyPair | null = null
  private clientNonce: Uint8Array<ArrayBuffer> | null = null
  private keys: DerivedKeys | null = null
  private rx = -1
  private tx = 0
  /** 发送序列化链——加密按序消费计数器（乱序即对端拒收） */
  sendChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly hostPublicKeyB64: string,
    private readonly auth: string,
  ) {}

  get readyState(): boolean {
    return this.state === 'ready' || this.state === 'wait-ok'
  }

  /** 生成并发送 e2ee_hello */
  async startHello(): Promise<string> {
    const s = subtle()
    this.eph = (await s.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
    this.clientNonce = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)))
    this.state = 'wait-ready'
    const ephRaw = await s.exportKey('raw', this.eph.publicKey)
    return JSON.stringify({ t: 'e2ee_hello', ephPubB64: b64encode(ephRaw), clientNonceB64: b64encode(this.clientNonce) })
  }

  /** 握手阶段入站帧（e2ee_ready → 派生+回密文 e2ee_auth；密文 e2ee_ok → ready） */
  async onHandshakeFrame(text: string): Promise<{ send?: string; ready?: boolean }> {
    const s = subtle()
    if (this.state === 'wait-ready') {
      const msg = JSON.parse(text) as { t?: string; hostNonceB64?: string }
      if (msg.t !== 'e2ee_ready' || typeof msg.hostNonceB64 !== 'string') throw new Error('e2ee 握手异常（期望 ready）')
      const hostPub = await s.importKey('raw', b64decode(this.hostPublicKeyB64), 'X25519', false, [])
      const shared = await s.deriveBits({ name: 'X25519', public: hostPub }, this.eph!.privateKey, 256)
      this.keys = await deriveKeys(shared, this.clientNonce!, b64decode(msg.hostNonceB64))
      this.state = 'wait-ok'
      return { send: await this.encodeNow({ t: 'e2ee_auth', auth: this.auth }) }
    }
    if (this.state === 'wait-ok') {
      const frame = await this.decodeNow(text)
      if (frame === null || (frame as { t?: string }).t !== 'e2ee_ok') throw new Error('e2ee 握手异常（auth 被拒或帧损坏）')
      this.state = 'ready'
      return { ready: true }
    }
    return {}
  }

  async decode(text: string): Promise<Record<string, unknown> | null> {
    return this.decodeNow(text)
  }

  private async decodeNow(text: string): Promise<Record<string, unknown> | null> {
    if (this.keys === null) return null
    let msg: { t?: string; n?: string; c?: string }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return null
    }
    if (msg.t !== 'enc' || typeof msg.n !== 'string' || typeof msg.c !== 'string') return null
    const nonce = b64decode(msg.n)
    const expected = buildNonce(DIR_D2P, this.rx + 1)
    // 严格计数器：nonce 域逐字节等值（重放/乱序/域不符一律拒）
    for (let i = 0; i < NONCE_LEN; i++) {
      if (nonce[i] !== expected[i]) return null
    }
    const raw = b64decode(msg.c)
    if (raw.length < 16) return null
    try {
      const aad = new Uint8Array(this.keys.sessionIdSeg.length + NONCE_LEN)
      aad.set(this.keys.sessionIdSeg, 0)
      aad.set(nonce, this.keys.sessionIdSeg.length)
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, this.keys.d2p, raw)
      this.rx++
      return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** 出站加密（串行链——保序消费计数器） */
  encode(obj: unknown): Promise<string> {
    const next = this.sendChain.then(() => this.encodeNow(obj))
    this.sendChain = next.then(
      () => undefined,
      () => undefined, // 失败不阻塞后续（连接已废，close 收割）
    )
    return next
  }

  private async encodeNow(obj: unknown): Promise<string> {
    if (this.keys === null) throw new Error('e2ee 未就绪')
    const nonce = buildNonce(DIR_P2D, this.tx++)
    const aad = new Uint8Array(new ArrayBuffer(this.keys.sessionIdSeg.length + NONCE_LEN))
    aad.set(this.keys.sessionIdSeg, 0)
    aad.set(nonce, this.keys.sessionIdSeg.length)
    const pt = new TextEncoder().encode(JSON.stringify(obj))
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, this.keys.p2d, pt)
    return JSON.stringify({ t: 'enc', n: b64encode(nonce), c: b64encode(ct) })
  }
}
