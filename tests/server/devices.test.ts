/**
 * R1 DeviceRegistry 单测：配对生成/持久化读回/吊销/findBySecret——persist-before-swap 不变量。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DeviceRegistry, formatDevicesText, probeRunningDaemon, revokeDeviceText } from '../../src/server/devices.js'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

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

// ———————— R 线：/devices 命令文本面（daemon 探测/列表/吊销） ————————
describe('devices 文本面（TUI /devices 与 pair CLI 共用）', () => {
  it('daemon 不在：本地注册表直读 + 本地吊销回退', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-devtext-'))
    try {
      const regPath = path.join(dir, 'server.json') // 不存在 → probe null
      expect(await probeRunningDaemon(regPath)).toBeNull()
      expect(await formatDevicesText(regPath)).toContain('尚无配对设备')
      new DeviceRegistry(path.join(dir, 'devices.json')).create('手机', 'chat')
      const list = await formatDevicesText(regPath)
      expect(list).toContain('配对设备（1）')
      expect(list).toContain('手机')
      expect(list).toContain('对话+只读')
      const id = new DeviceRegistry(path.join(dir, 'devices.json')).list()[0].deviceId
      expect(await revokeDeviceText(id, regPath)).toContain('✓ 已吊销')
      expect(await revokeDeviceText(id, regPath)).toContain('未找到设备')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('daemon 在跑：列表/吊销走 HTTP（三步序语义经 daemon）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-devtext2-'))
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, id: 'sess-1' }))
      if (req.url === '/api/devices' && req.method === 'GET') {
        return res.end(JSON.stringify({ ok: true, devices: [{ deviceId: 'dev-x', name: '远端列表', scope: 'chat', pairedAt: 'now' }] }))
      }
      if (req.url === '/api/devices/revoke' && req.method === 'POST') {
        let body = ''
        req.on('data', (c: Buffer) => (body += c.toString()))
        return req.on('end', () => {
          const parsed = JSON.parse(body) as { deviceId?: string }
          res.end(JSON.stringify({ ok: parsed.deviceId === 'dev-live' }))
        })
      }
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    const regPath = path.join(dir, 'server.json')
    // daemon pid 用当前进程（kill 0 探活必过）
    fs.writeFileSync(regPath, JSON.stringify({ pid: process.pid, port, token: 'tok', id: 'sess-1' }), 'utf8')
    try {
      expect(await probeRunningDaemon(regPath)).not.toBeNull()
      const list = await formatDevicesText(regPath)
      expect(list).toContain('经运行中 daemon')
      expect(list).toContain('远端列表')
      expect(await revokeDeviceText('dev-nope', regPath)).toContain('✗')
      expect(await revokeDeviceText('dev-live', regPath)).toContain('即时生效')
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})