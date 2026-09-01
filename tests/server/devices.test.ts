/**
 * R1 DeviceRegistry 单测：配对生成/持久化读回/吊销/findBySecret——persist-before-swap 不变量。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DeviceRegistry } from '../../src/server/devices.js'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-devices-')), 'devices.json')
}

describe('DeviceRegistry（R1 配对设备注册表）', () => {
  let file: string
  beforeEach(() => {
    file = tmpFile()
  })

  it('配对：生成 192-bit hex secret+条目落盘，新实例读回一致（persist-before-swap）', () => {
    const r1 = new DeviceRegistry(file)
    const entry = r1.create('我的手机', 'chat', 'iOS')
    expect(entry.secret).toMatch(/^[0-9a-f]{48}$/) // 192-bit hex
    expect(entry.deviceId).toMatch(/^dev-[0-9a-f]{12}$/)
    expect(entry.scope).toBe('chat')

    const r2 = new DeviceRegistry(file) // 新实例=从盘加载
    const list = r2.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ deviceId: entry.deviceId, name: '我的手机', secret: entry.secret, note: 'iOS' })
  })

  it('findBySecret：命中返回设备，未命中 null（daemon 鉴权入口）', () => {
    const r = new DeviceRegistry(file)
    const e = r.create('平板', 'full')
    expect(r.findBySecret(e.secret)?.deviceId).toBe(e.deviceId)
    expect(r.findBySecret('not-a-secret')).toBeNull()
  })

  it('吊销：物理删除（下一请求 401 语义），不存在返回 false', () => {
    const r1 = new DeviceRegistry(file)
    const a = r1.create('a')
    const b = r1.create('b')
    expect(r1.revoke(a.deviceId)).toBe(true)
    const r2 = new DeviceRegistry(file)
    expect(r2.list().map((d) => d.deviceId)).toEqual([b.deviceId])
    expect(r2.revoke('no-such')).toBe(false)
  })

  it('多设备混合 scope（chat/full）互不干扰', () => {
    const r = new DeviceRegistry(file)
    r.create('手机', 'chat')
    r.create('平板', 'full')
    const list = new DeviceRegistry(file).list()
    expect(list.map((d) => d.scope).sort()).toEqual(['chat', 'full'])
  })
})
