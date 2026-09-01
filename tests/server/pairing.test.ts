/**
 * R 线 pairing 服务面单测：offer/深链组装（scheme 归一+projects 归一+base64url 回读）、
 * 终端二维码渲染、createPairingFull 双形态（daemon mock / 离线）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildPairingLink, createPairingFull, renderQrText } from '../../src/server/pairing.js'
import { DeviceRegistry } from '../../src/server/devices.js'

describe('buildPairingLink', () => {
  it('scheme 归一（wss:→https:）+ base64url 回读等值', () => {
    const offer = {
      v: 1,
      deviceId: 'dev-1',
      name: '我的手机',
      scope: 'chat',
      secret: 'sec-中文',
      daemonPubKeyB64: 'PUB',
      projects: ['D:/work/a'],
      webOrigin: 'wss://relay.example.com/ecode',
      relay: { connectUrl: 'wss://relay.example.com/ecode/v1/connect/h1', hostId: 'h1', inviteToken: 'inv', expiresAt: 0 },
    }
    const link = buildPairingLink(offer)
    expect(link.startsWith('https://relay.example.com/ecode/#pairing=')).toBe(true)
    const decoded = JSON.parse(Buffer.from(link.split('#pairing=')[1], 'base64url').toString('utf8'))
    expect(decoded).toEqual(offer) // 回读等值（中文安全）
    expect(decoded.relay.connectUrl.startsWith('wss://')).toBe(true) // WS 地址保持 wss
  })
})

describe('renderQrText', () => {
  it('渲染块字符二维码（qrcode-terminal small）', () => {
    const qr = renderQrText('https://example.com/pairing-test')
    expect(qr).not.toBe('')
    expect(/[▀▄█]/.test(qr)).toBe(true)
    expect(qr).toContain('\n')
  })
})

describe('createPairingFull', () => {
  it('daemon 在跑：活注入 offer（钉公钥/中继段/projects 归一）+ https 深链', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-pairing-'))
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, id: 'sess-9' }))
      if (req.url === '/api/devices' && req.method === 'POST') {
        return res.end(
          JSON.stringify({
            ok: true,
            device: { deviceId: 'dev-p', name: '手机-ab12', scope: 'chat' },
            secret: 'sec-123',
            daemonPubKeyB64: 'PUBKEY',
            projects: [{ path: 'D:/work/a', registered: true }], // listKnown 对象形态——必须归一
            webOrigin: 'wss://relay.example.com/ecode',
            relay: { connectUrl: 'wss://relay.example.com/ecode/v1/connect/h1', hostId: 'h1', inviteToken: 'inv-1234567890', expiresAt: 0 },
          }),
        )
      }
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    const regPath = path.join(dir, 'server.json')
    fs.writeFileSync(regPath, JSON.stringify({ pid: process.pid, port, token: 'tok', id: 'sess-9' }), 'utf8')
    try {
      const r = await createPairingFull('手机-ab12', 'chat', undefined, { regPath })
      expect(r.viaDaemon).toBe(true)
      expect(r.link).toBeDefined()
      expect(r.link!.startsWith('https://relay.example.com/ecode/#pairing=')).toBe(true)
      expect(r.qrText).not.toBe('')
      const offer = JSON.parse(Buffer.from(r.link!.split('#pairing=')[1], 'base64url').toString('utf8')) as { projects?: unknown[] }
      expect(offer.projects).toEqual(['D:/work/a']) // 归一为字符串
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('daemon 不在：离线形态（注册表落盘、无链接、如实标注）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-pairing2-'))
    try {
      const regPath = path.join(dir, 'server.json') // 不存在 → 离线
      const r = await createPairingFull('离线设备', 'chat', undefined, { regPath })
      expect(r.viaDaemon).toBe(false)
      expect(r.link).toBeUndefined()
      expect(r.qrText).toBe('')
      const local = new DeviceRegistry(path.join(dir, 'devices.json')).list()
      expect(local.map((d) => d.name)).toEqual(['离线设备'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
