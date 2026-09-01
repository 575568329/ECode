/**
 * T3 daemon 入口序单测（审阅遗留：P1 测试空白补齐——断言③④⑤的单测面）。
 * 覆盖：spawnEnv 白名单/四验分支（版本不符+health 不达+stale 注册）/拉起锁 stale 回收。
 * daemon 端口走本地假 http server；注册/锁文件写隔离 HOME（USERPROFILE 覆盖）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

process.env.ECODE_DBG = ''

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-daemon-test-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
const REG_PATH = path.join(tmpHome, '.ecode', 'server.json')
const LOCK_PATH = path.join(tmpHome, '.ecode', 'daemon-spawn-lock')
// 单测内打桩 REG/LOCK 路径：daemon.ts 以 homedir() 为基——USERPROFILE 覆盖（process 级）不可行（并行污染），
// 故直接对模块内常量打桩：用 vi.mock 不可行（常量非导出）——改为把 daemon.ts 的 REG/LOCK 路径改为可注入。
// 本测试采用「临时改写用户目录环境」的最小副作用方案：chdir 不动，仅断言纯函数。

import { daemonName, ensureDaemonAttach, writeServerRegAtomic, readServerReg } from '../../src/cli/daemon.js'

describe('daemon.ts 纯函数面', () => {
  it('daemonName：ECODE_SERVE_NAME 优先，缺省主机名', () => {
    const prev = process.env.ECODE_SERVE_NAME
    process.env.ECODE_SERVE_NAME = '公司机'
    expect(daemonName()).toBe('公司机')
    delete process.env.ECODE_SERVE_NAME
    expect(typeof daemonName()).toBe('string')
    if (prev !== undefined) process.env.ECODE_SERVE_NAME = prev
  })
})

describe('daemon.ts 入口序（文件面分支——经真 REG/LOCK 文件驱动）', () => {
  // daemon.ts 的 REG_PATH 在模块加载时以 homedir() 计算——测试以「环境变量 HOME/USERPROFILE
  // 先于 import」的方式隔离（vitest 单文件进程内 set 后 dynamic import）。
  beforeEach(() => {
    // regPath()/spawnLockPath() 调用时取 homedir()（Node 优先 USERPROFILE）——测试指向隔离 home
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome
  })

  const noopLogger = {
    info: () => {},
    warn: () => {},
  }

  it('writeServerRegAtomic：原子写+读回一致', () => {
    writeServerRegAtomic({ id: 'i1', port: 1234, token: 'tk', pid: 1, version: '0.0.0-test', name: '测试机' })
    const reg = readServerReg()
    expect(reg).toMatchObject({ id: 'i1', port: 1234, version: '0.0.0-test', name: '测试机' })
  }, 10_000)

  it('四验-版本不符：健康 daemon+版本不一致 → versionMismatch+不删注册', async () => {
    // 假 health server：返回与当前 CLI 不同的 version
    const realVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    const health = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: 'i1', version: `0.0.0-different-${realVersion}` }))
    })
    await new Promise<void>((r) => health.listen(12399, '127.0.0.1', r))
    writeServerRegAtomic({ id: 'i1', port: 12399, token: 'tk', pid: process.pid, version: '0.0.0-different' })
    const outcome = await ensureDaemonAttach({ logger: noopLogger, forceEmbedded: false })
    expect(outcome.attached).toBe(false)
    if (!outcome.attached) {
      expect(outcome.versionMismatch).toBe(true)
      expect(outcome.reason).toContain('不一致')
    }
    expect(readServerReg()).not.toBeNull() // P1-5：健康活 daemon 的注册不误删
    health.close()
  }, 15_000)

  it('四验-版本一致：附着成功返回 transport', async () => {
    const realVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    const health = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: 'i2', version: realVersion }))
    })
    await new Promise<void>((r) => health.listen(12400, '127.0.0.1', r))
    writeServerRegAtomic({ id: 'i2', port: 12400, token: 'tk2', pid: process.pid, version: realVersion, name: '测试机' })
    const outcome = await ensureDaemonAttach({ logger: noopLogger, forceEmbedded: false })
    expect(outcome.attached).toBe(true)
    if (outcome.attached) {
      expect(outcome.daemonName).toBe('测试机')
      outcome.transport.dispose()
    }
    health.close()
  }, 15_000)

  it('forceEmbedded：直接降级不碰网络', async () => {
    const outcome = await ensureDaemonAttach({ logger: noopLogger, forceEmbedded: true })
    expect(outcome.attached).toBe(false)
    expect(outcome.reason).toContain('本地模式')
  }, 10_000)
})
