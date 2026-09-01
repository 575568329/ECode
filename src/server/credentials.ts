/**
 * M14-C2①/D13：凭据条目化最小版——daemon 侧多凭据结构与分级校验。
 *
 * 背景（安全审阅 P1-2/P1-7）：原实现是扁平 Set<string>+has 比对——
 * ①非常量时（计时侧信道）；②凡能到达 confirm 门的请求必已持凭据，
 * "token 持有"作为豁免信号恒真，`?confirm=true` 客户端自报形同虚设。
 *
 * 本模块给出最小分级形态（M14 产品化线 R1 的地基，勿在此扩设备管理）：
 * - primary：serve 启动 token（server.json 持有方）——唯一可 confirm 豁免/注册项目的等级；
 * - lan-password：非 loopback 绑定的密码（第二凭据）——同 primary 信任级（用户亲手设置）；
 * - device：R 线配对设备凭据（当前无人写入，结构先行）——不可 confirm 豁免。
 *
 * 常量时比较：先 SHA-256 摘要再 timingSafeEqual（等长固定 32 字节，
 * 规避长度泄漏；摘要比较在 secret 高熵前提下不降低安全性——orca/CC 同款做法）。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export type CredentialClass = 'primary' | 'lan-password' | 'device'

export interface CredentialEntry {
  secret: string
  class: CredentialClass
}

/** 摘要缓存（secret 高熵随机串，条目个位数——启动/配对时写入，无需淘汰） */
const digestOf = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest()

export class CredentialStore {
  private readonly entries: Array<{ entry: CredentialEntry; digest: Buffer }> = []

  add(secret: string, klass: CredentialClass): void {
    if (secret === '') return
    this.entries.push({ entry: { secret, class: klass }, digest: digestOf(secret) })
  }

  /** R2 吊销三步序第②步：运行中 daemon 的活凭据摘除（此前吊销需重启——R1 披露项收口）。
   *  逐条摘要常量时比较，命中全删（同 secret 多条目一并失效）；返回是否删除过。 */
  remove(secret: string): boolean {
    if (secret === '') return false
    const d = digestOf(secret)
    const before = this.entries.length
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (timingSafeEqual(d, this.entries[i].digest)) this.entries.splice(i, 1)
    }
    return this.entries.length !== before
  }

  /** 常量时校验：命中返回凭据等级，未命中返回 null（逐条 timingSafeEqual，不短路） */
  verify(presented: string): CredentialClass | null {
    if (presented === '') return null
    const d = digestOf(presented)
    let hit: CredentialClass | null = null
    for (const e of this.entries) {
      if (timingSafeEqual(d, e.digest)) hit = e.entry.class
    }
    return hit
  }

  /** confirm 豁免/项目注册只认用户亲手持有或设置的一等凭据（device 不算） */
  get hasPrimary(): boolean {
    return this.entries.some((e) => e.entry.class !== 'device')
  }
}
