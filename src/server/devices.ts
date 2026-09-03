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
import { dirname, join } from 'node:path'
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
  /** 审阅修复（安全席 P1-1）：配对时刻的项目快照（规范化路径数组）——服务端强制边界。
   *  undefined=存量条目（机制上线前配对，语义=不限制——重配对即获得快照保护） */
  allowedProjects?: string[]
}

export class DeviceRegistry {
  private devices: DeviceEntry[] = []
  /** 本实例已删除的条目（墓碑）——persist 合并磁盘时过滤，防吊销被并集复活 */
  private removedIds = new Set<string>()
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

  /** persist-before-swap：先落盘（tmp+rename 0600）成功后才提交内存。
   *  审阅修复（开发席 P1-1 lost update）：写前重读磁盘按 deviceId 并集合并——TUI/CLI 离线
   *  直写与 daemon 内存副本互相覆盖曾静默抹条目（幽灵凭据：secret 已交给用户，条目没了） */
  private persist(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: DeviceEntry[] }
      const disk = Array.isArray(parsed.devices) ? parsed.devices : []
      const known = new Set(this.devices.map((d) => d.deviceId))
      for (const d of disk) {
        if (typeof d.deviceId === 'string' && !known.has(d.deviceId) && !this.removedIds.has(d.deviceId)) this.devices.push(d)
      }
    } catch {
      /* 磁盘不可读=按内存全量写（首启/损坏重建） */
    }
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
  create(name: string, scope: DeviceScope = 'chat', note?: string, allowedProjects?: string[]): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: `dev-${randomBytes(6).toString('hex')}`,
      name,
      secret: randomBytes(24).toString('hex'),
      scope,
      pairedAt: new Date().toISOString(),
      ...(note !== undefined && note !== '' ? { note } : {}),
      ...(allowedProjects !== undefined ? { allowedProjects } : {}),
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
    this.removedIds.add(deviceId) // 墓碑：persist 合并磁盘时过滤（防并集复活）
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

// ———————— R 线：设备管理文本面（pair CLI 与 TUI /devices 命令共用） ————————

export interface RunningDaemon {
  port: number
  token: string
}

/** 运行中 daemon 探测（server.json + /api/health 身份核验——killServeByReg 同款防陈旧 PID；
 *  regPath 供测试注入临时目录） */
export async function probeRunningDaemon(regPath?: string): Promise<RunningDaemon | null> {
  try {
    const p = regPath ?? join(homedir(), '.ecode', 'server.json')
    if (!existsSync(p)) return null
    const reg = JSON.parse(readFileSync(p, 'utf8')) as { pid: number; port: number; token: string; id?: string }
    process.kill(reg.pid, 0)
    const res = await fetch(`http://127.0.0.1:${reg.port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const h = (await res.json()) as { ok?: boolean; id?: string }
    if (h.ok !== true || (reg.id !== undefined && h.id !== reg.id)) return null
    return { port: reg.port, token: reg.token }
  } catch {
    return null
  }
}

function registryFor(regPath?: string): DeviceRegistry {
  return regPath !== undefined ? new DeviceRegistry(join(dirname(regPath), 'devices.json')) : new DeviceRegistry()
}

/** 设备列表文本（daemon 在跑走 HTTP——含 relay invite 标记与运行态；否则本地注册表） */
export async function formatDevicesText(regPath?: string): Promise<string> {
  const daemon = await probeRunningDaemon(regPath)
  let list: DeviceEntry[] = registryFor(regPath).list()
  let viaDaemon = false
  if (daemon !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, {
        headers: { authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(3000),
      })
      const r = (await res.json()) as { devices?: DeviceEntry[] }
      if (res.ok && Array.isArray(r.devices)) {
        list = r.devices
        viaDaemon = true
      }
    } catch {
      /* daemon 查询失败落本地表（可能已退出） */
    }
  }
  if (list.length === 0) {
    return '尚无配对设备。新设备接入：电脑终端 `ecode pair <名字>`（终端出二维码），或本机 web 设备面板生成配对链接。'
  }
  const lines = [`配对设备（${list.length}）${viaDaemon ? '（经运行中 daemon）' : ''}：`]
  for (const d of list) {
    lines.push(
      `  ${d.deviceId}  ${d.name}  [${d.scope === 'full' ? '全功能' : '对话+只读'}]  配对于 ${d.pairedAt}${d.relayInvite !== undefined ? '  [中继]' : ''}`,
    )
  }
  lines.push('吊销：/devices revoke <deviceId>（即时断连）')
  return lines.join('\n')
}

/** 吊销（daemon HTTP 优先——同步 relay 断连+活凭据摘除三步序；daemon 不在/不可达回退本地注册表删） */
export async function revokeDeviceText(id: string, regPath?: string): Promise<string> {
  if (id === '') return '用法：/devices revoke <deviceId>'
  const daemon = await probeRunningDaemon(regPath)
  if (daemon !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: JSON.stringify({ deviceId: id }),
        signal: AbortSignal.timeout(5000),
      })
      const r = (await res.json()) as { ok?: boolean; error?: string }
      if (res.ok && r.ok === true) return `✓ 已吊销 ${id}（运行中 daemon 即时生效——凭据活摘除+中继断连，下一请求 401）`
      if (res.status !== 404) return `✗ daemon 吊销失败（HTTP ${res.status}${r.error !== undefined ? `：${r.error}` : ''}）`
      // 404=daemon 注册表无此条——落本地删（daemon 起前写入的条目）
    } catch {
      /* daemon 不可达——落本地删（活凭据断连未确认，文案如实说） */
    }
  }
  const ok = registryFor(regPath).revoke(id)
  if (!ok) return `✗ 未找到设备 ${id}`
  return daemon !== null
    ? `✓ 已吊销 ${id}（本机注册表；daemon 活凭据断连未确认——如 daemon 在跑，重启后即彻底生效）`
    : `✓ 已吊销 ${id}（本机注册表；daemon 未在跑——下次启动即不再认此设备）`
}
