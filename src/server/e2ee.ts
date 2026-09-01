/**
 * R3：E2EE 端点（M14 产品化线 R 方案 §7——中继只见密文信封，D4 拍板 relay 形态强制）。
 *
 * 算法面：X25519（ECDH）+ HKDF-SHA256（三段派生）+ AES-256-GCM——Node crypto 与浏览器
 * WebCrypto 同款原语，两端零第三方加密库。
 *
 * 密钥调度（per-socket 新鲜——orca v2 蓝本）：
 *   shared = X25519(clientEph, hostStatic)            // 手机用 offer 钉住的 host 静态公钥
 *   HKDF(ikm=shared, salt='ecode-e2ee-v2'||clientNonce||hostNonce, info='keys', 96B)
 *     → [0:32]=p2d（手机→daemon）[32:64]=d2p（daemon→手机）[64:96]=sessionIdSeg
 *   双 nonce+方向分钥 → 每 socket 密钥唯一，握手帧不可替换/不可跨连接重放（v1 五缺陷的对症面）。
 *
 * nonce/计数器（T4 防重放）：12B 确定性布局 `v=2 || dir || kind=1 || pad || counter(u64BE)`。
 * 方案 §7.1 的 24B 布局是 orca secretbox 原语；GCM 标准 IV=96bit，会话绑定段改入 AAD
 * （AAD = sessionIdSeg || nonce）——域绑定面不变，IV 无跨计数器碰撞风险。
 * 接收侧严格递增计数器：入站 counter 必须精确等于期望值（错位即解密失败=断腿 fail-close，
 * 无窗口容忍）；出站 counter 发送时消费。重放帧 counter 落后必拒。
 *
 * 数据腿握手（明文→密文）：
 *   P→D e2ee_hello{ephPubB64, clientNonceB64}   ← 明文（密钥交换必须明文）
 *   D→P e2ee_ready{hostNonceB64}                ← 明文
 *   P→D enc{t:'e2ee_auth', auth}                ← 密文（设备凭据从此不落中继明文）
 *   D→P enc{t:'e2ee_ok'}                        ← 密文；此后全部帧 enc
 */

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { CredentialClass } from './credentials.js'

export const E2EE_DOMAIN = 'ecode-e2ee-v2'
export const E2EE_VERSION = 2
const NONCE_LEN = 12
const HKDF_LEN = 96
const DIR_P2D = 0
const DIR_D2P = 1
const KIND_DATA = 1

// ———————————————— 钥匙管理 ————————————————
export interface E2eeKeypair {
  publicKeyB64: string
  privateKeyB64: string
}

/** X25519 原始 32B ↔ DER 前缀（SPKI/PKCS8 尾段即 raw key——WebCrypto 互操作面） */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function generateKeypair(): E2eeKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
  }
}

function importPublic(raw32: Buffer) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
}

function importPrivate(raw32: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32]), format: 'der', type: 'pkcs8' })
}

/** daemon 静态钥匙：~/.ecode/keys/e2ee.json（0600，首启生成；tmp+rename 原子写） */
export function loadOrCreateHostKeys(file?: string): E2eeKeypair & { file: string } {
  const path = file ?? join(homedir(), '.ecode', 'keys', 'e2ee.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as E2eeKeypair
    if (typeof parsed.publicKeyB64 === 'string' && typeof parsed.privateKeyB64 === 'string') return { ...parsed, file: path }
  } catch {
    /* 无文件/损坏=重生成（旧 offer 里的公钥随之失效——重配对即可，披露） */
  }
  const kp = generateKeypair()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(kp, null, 2), { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* 非 POSIX 不阻断 */
  }
  renameSync(tmp, path)
  return { ...kp, file: path }
}

// ———————————————— 派生与帧 ————————————————
export function deriveKeys(sharedSecret: Buffer, clientNonce: Buffer, hostNonce: Buffer): { p2d: Buffer; d2p: Buffer; sessionIdSeg: Buffer } {
  const salt = Buffer.concat([Buffer.from(E2EE_DOMAIN), clientNonce, hostNonce])
  const okm = Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from('keys'), HKDF_LEN))
  return { p2d: okm.subarray(0, 32), d2p: okm.subarray(32, 64), sessionIdSeg: okm.subarray(64, 96) }
}

/** 12B 确定性 nonce：v || dir || kind || pad || counter(u64BE)（无 RNG——布局即域绑定） */
export function buildNonce(dir: number, counter: number): Buffer {
  const n = Buffer.alloc(NONCE_LEN)
  n[0] = E2EE_VERSION
  n[1] = dir
  n[2] = KIND_DATA
  n[3] = 0
  n.writeBigUInt64BE(BigInt(counter), 4)
  return n
}

function seal(key: Buffer, nonce: Buffer, sessionIdSeg: Buffer, plaintext: string): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.concat([sessionIdSeg, nonce]))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return ct.toString('base64')
}

/** 开封：counter 严格相等才成（返回 null=解密失败/重放/域不符——调用方断腿） */
function open(key: Buffer, nonce: Buffer, sessionIdSeg: Buffer, ctB64: string, expectedCounter: number): string | null {
  if (nonce.length !== NONCE_LEN) return null
  if (nonce[0] !== E2EE_VERSION || nonce[2] !== KIND_DATA) return null
  if (nonce.readBigUInt64BE(4) !== BigInt(expectedCounter)) return null // 重放/乱序即拒（严格计数器）
  const raw = Buffer.from(ctB64, 'base64')
  if (raw.length < 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.concat([sessionIdSeg, nonce]))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const pt = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null // GCM 认证失败（篡改/密钥不符）
  }
}

/** 密文信封（数据腿通用形态） */
function envelope(nonce: Buffer, sealedB64: string): string {
  return JSON.stringify({ t: 'enc', n: nonce.toString('base64'), c: sealedB64 })
}
function parseEnvelope(text: string): { nonce: Buffer; ct: string } | null {
  try {
    const msg = JSON.parse(text) as { t?: string; n?: string; c?: string }
    if (msg.t !== 'enc' || typeof msg.n !== 'string' || typeof msg.c !== 'string') return null
    return { nonce: Buffer.from(msg.n, 'base64'), ct: msg.c }
  } catch {
    return null
  }
}

function transcriptHash(...parts: Buffer[]): Buffer {
  return createHash('sha256').update(Buffer.concat(parts)).digest()
}

// ———————————————— daemon 侧会话（relayClient 数据腿消费，同步 LegSession 形态） ————————————————
export interface HandshakeStep {
  ready: boolean
  send?: string
  close?: { code: number; reason: string }
}

export class E2eeHostSession {
  private state: 'wait-hello' | 'wait-auth' | 'ready' = 'wait-hello'
  private keys: { p2d: Buffer; d2p: Buffer; sessionIdSeg: Buffer } | null = null
  private rx = -1 // 期望的下一入站 counter（wait-auth 前 -1 占位；ready 后从 0 起）
  private tx = 0
  private _auth = ''
  private readonly hostPriv: ReturnType<typeof importPrivate>

  constructor(
    hostPrivateKeyB64: string,
    private readonly verifyAuth: (secret: string) => CredentialClass | null,
  ) {
    this.hostPriv = importPrivate(Buffer.from(hostPrivateKeyB64, 'base64'))
  }

  get auth(): string {
    return this._auth
  }

  /** 明文/握手阶段逐帧驱动（relayClient DataLeg LegSession 契约） */
  onHandshake(text: string): HandshakeStep {
    if (this.state === 'wait-hello') {
      let msg: { t?: string; ephPubB64?: string; clientNonceB64?: string }
      try {
        msg = JSON.parse(text) as typeof msg
      } catch {
        return { ready: false, close: { code: 4001, reason: 'e2ee required' } }
      }
      if (msg.t !== 'e2ee_hello' || typeof msg.ephPubB64 !== 'string' || typeof msg.clientNonceB64 !== 'string') {
        return { ready: false, close: { code: 4001, reason: 'e2ee required' } } // 明文 hello/无 e2ee=拒（D4 强制面）
      }
      try {
        const clientNonce = Buffer.from(msg.clientNonceB64, 'base64')
        if (clientNonce.length !== 32) return { ready: false, close: { code: 4001, reason: 'bad nonce' } }
        const shared = diffieHellman({ privateKey: this.hostPriv, publicKey: importPublic(Buffer.from(msg.ephPubB64, 'base64')) })
        const hostNonce = randomBytes(32)
        this.keys = deriveKeys(Buffer.from(shared), clientNonce, hostNonce)
        this.state = 'wait-auth'
        return { ready: false, send: JSON.stringify({ t: 'e2ee_ready', hostNonceB64: hostNonce.toString('base64') }) }
      } catch {
        return { ready: false, close: { code: 4001, reason: 'e2ee handshake failed' } }
      }
    }
    if (this.state === 'wait-auth') {
      const env = parseEnvelope(text)
      if (env === null || this.keys === null) return { ready: false, close: { code: 4001, reason: 'bad envelope' } }
      const pt = open(this.keys.p2d, env.nonce, this.keys.sessionIdSeg, env.ct, this.rx + 1)
      if (pt === null) return { ready: false, close: { code: 4003, reason: 'decrypt failed' } } // 4001/4003 对齐 orca 失败码
      this.rx++
      let authFrame: { t?: string; auth?: string }
      try {
        authFrame = JSON.parse(pt) as typeof authFrame
      } catch {
        return { ready: false, close: { code: 4001, reason: 'bad auth frame' } }
      }
      if (authFrame.t !== 'e2ee_auth' || typeof authFrame.auth !== 'string' || this.verifyAuth(authFrame.auth) === null) {
        return { ready: false, close: { code: 4001, reason: 'auth rejected' } }
      }
      this._auth = authFrame.auth
      this.state = 'ready'
      const okFrame = this.seal({ t: 'e2ee_ok' })
      return { ready: true, send: okFrame }
    }
    return { ready: true }
  }

  get readyState(): boolean {
    return this.state === 'ready'
  }

  encode(obj: unknown): string {
    return this.seal(obj)
  }

  decode(text: string): Record<string, unknown> | null {
    if (this.keys === null) return null
    const env = parseEnvelope(text)
    if (env === null) return null
    const pt = open(this.keys.p2d, env.nonce, this.keys.sessionIdSeg, env.ct, this.rx + 1)
    if (pt === null) return null
    this.rx++
    try {
      return JSON.parse(pt) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private seal(obj: unknown): string {
    if (this.keys === null) throw new Error('e2ee 未就绪')
    const nonce = buildNonce(DIR_D2P, this.tx++)
    return envelope(nonce, seal(this.keys.d2p, nonce, this.keys.sessionIdSeg, JSON.stringify(obj)))
  }

  /** transcript 摘要（审计/诊断用——双 nonce+公钥绑定面） */
  fingerprint(): string {
    return this.keys !== null ? transcriptHash(this.keys.sessionIdSeg).toString('hex').slice(0, 16) : ''
  }
}

// ———————————————— Node 客户端会话（集成测试 phone-sim/契约测试用——web 侧另有 WebCrypto 实现） ————————————————
export class E2eeClientSession {
  private state: 'init' | 'wait-ready' | 'ready' = 'init'
  private eph: ReturnType<typeof generateKeyPairSync> | null = null
  private clientNonce: Buffer | null = null
  private keys: { p2d: Buffer; d2p: Buffer; sessionIdSeg: Buffer } | null = null
  private rx = -1
  private tx = 0

  constructor(
    private readonly hostPublicKeyB64: string,
    private readonly auth: string,
  ) {}

  /** 生成并发送 e2ee_hello（返回待发帧） */
  start(): string {
    this.eph = generateKeyPairSync('x25519')
    this.clientNonce = randomBytes(32)
    this.state = 'wait-ready'
    return JSON.stringify({
      t: 'e2ee_hello',
      ephPubB64: this.eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
      clientNonceB64: this.clientNonce.toString('base64'),
    })
  }

  /** 处理入站帧（e2ee_ready → 派生+回 e2ee_auth；enc e2ee_ok → ready） */
  onMessage(text: string): { send?: string; ready?: boolean; error?: string } {
    if (this.state === 'wait-ready') {
      let msg: { t?: string; hostNonceB64?: string }
      try {
        msg = JSON.parse(text) as typeof msg
      } catch {
        return { error: 'bad ready frame' }
      }
      if (msg.t !== 'e2ee_ready' || typeof msg.hostNonceB64 !== 'string') return { error: 'bad ready frame' }
      const hostNonce = Buffer.from(msg.hostNonceB64, 'base64')
      if (hostNonce.length !== 32) return { error: 'bad host nonce' }
      const shared = diffieHellman({ privateKey: this.eph!.privateKey, publicKey: importPublic(Buffer.from(this.hostPublicKeyB64, 'base64')) })
      this.keys = deriveKeys(Buffer.from(shared), this.clientNonce!, hostNonce)
      this.state = 'ready'
      return { send: this.seal({ t: 'e2ee_auth', auth: this.auth }) }
    }
    // ready 后的 e2ee_ok（或任何帧）走 decode
    return { ready: this.state === 'ready' }
  }

  get readyState(): boolean {
    return this.state === 'ready'
  }

  encode(obj: unknown): string {
    return this.seal(obj)
  }

  decode(text: string): Record<string, unknown> | null {
    if (this.keys === null) return null
    const env = parseEnvelope(text)
    if (env === null) return null
    const pt = open(this.keys.d2p, env.nonce, this.keys.sessionIdSeg, env.ct, this.rx + 1)
    if (pt === null) return null
    this.rx++
    try {
      return JSON.parse(pt) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private seal(obj: unknown): string {
    if (this.keys === null) throw new Error('e2ee 未就绪')
    const nonce = buildNonce(DIR_P2D, this.tx++)
    return envelope(nonce, seal(this.keys.p2d, nonce, this.keys.sessionIdSeg, JSON.stringify(obj)))
  }
}
