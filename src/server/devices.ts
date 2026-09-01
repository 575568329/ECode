/**
 * R1：配对设备注册表（M14 产品化线 R 方案 §5.2——D2 拍板 scope 分级+D7 不做滚动过期）。
 *
 * 不变量（orca 蓝本）：
 * - persist-before-swap：每次变更先落盘再换内存（崩溃不留幽灵条目）；
 * - 0600 落盘（Windows NTFS ACL 差异文档披露——credentials.ts 同款口径）；
 * - secret 为 192-bit CSPRNG hex（per-device，替代全局 token 的 T8 收口）；
 * - revoke 为标记删（条目物理删除+吊销即失效——本形态无 relay 云侧 outbox，本地删除即终态）。
 *
 * scope（D2 拍板）：chat=对话+只读命令；full=全功能（model/set 等）——reach 轴随 R2。
 */

import { readFileSync, writeFileSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export type DeviceScope = 'chat' | 'full'

export interface DeviceEntry {
  deviceId: string
  name: string
  /** 192-bit CSPRNG hex——per-device Bearer 凭据（T8 收口：泄漏只影响单设备，可吊销） */
  secret: string
  scope: DeviceScope
  pairedAt: string
  /** 设备备注的主机名/平台（offer 携带，可空） */
  note?: string
  /** R2：relay invite（配对时经控制腿登记——吊销时同步 revoke 并断活连接）；expiresAt 0=持久 */
  relayInvite?: { token: string; expiresAt: number }
}

export class DeviceRegistry {
  private devices: DeviceEntry[] = []
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? join(homedir(), '.ecode', 'devices.json')
    this.load()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: DeviceEntry[] }
      this.devices = Array.isArray(parsed.devices) ? parsed.devices : []
    } catch {
      this.devices = [] // 无文件/损坏=空表（配对即重建）
    }
  }

  /** persist-before-swap：先落盘（tmp+rename 0600）成功后才提交内存 */
  private persist(): void {
    const tmp = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2), { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* 非 POSIX 不阻断 */
    }
    renameSync(tmp, this.file)
  }

  /** 配对：生成设备条目（192-bit secret），落盘后返回（offer 组装由调用方做） */
  create(name: string, scope: DeviceScope = 'chat', note?: string): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: `dev-${randomBytes(6).toString('hex')}`,
      name,
      secret: randomBytes(24).toString('hex'),
      scope,
      pairedAt: new Date().toISOString(),
      ...(note !== undefined && note !== '' ? { note } : {}),
    }
    this.devices.push(entry)
    this.persist()
    return entry
  }

  list(): DeviceEntry[] {
    return [...this.devices]
  }

  /** 按 secret 查设备（daemon 鉴权用：命中且未删=有效 device 凭据） */
  findBySecret(secret: string): DeviceEntry | null {
    return this.devices.find((d) => d.secret === secret) ?? null
  }

  /** R2：把 relay invite 绑到设备条目（persist-before-swap） */
  attachInvite(deviceId: string, invite: { token: string; expiresAt: number }): void {
    const d = this.devices.find((x) => x.deviceId === deviceId)
    if (d === undefined) return
    d.relayInvite = invite
    this.persist()
  }

  /** 吊销：物理删除（本地形态即终态；被吊销设备的下一请求 401→回配对流） */
  revoke(deviceId: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (this.devices.length === before) return false
    this.persist()
    return true
  }

  /** 配对文件存在性（serve 启动判断是否注入 extraCredentials） */
  static exists(file?: string): boolean {
    return existsSync(file ?? join(homedir(), '.ecode', 'devices.json'))
  }
}

/** 设备注册表默认路径 */
export function devicesPath(): string {
  return join(homedir(), '.ecode', 'devices.json')
}
