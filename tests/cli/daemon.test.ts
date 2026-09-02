/**
 * T3 daemon 入口序单测（审阅遗留：P1 测试空白补齐——断言③④⑤的单测面）。
 * 覆盖：spawnEnv 白名单/四验分支（版本不符+health 不达+stale 注册）/拉起锁 stale 回收。
 * daemon 端口走本地假 http server；注册/锁文件写隔离 HOME（USERPROFILE 覆盖）。
 */
import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

process.env.ECODE_DBG = ''

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-daemon-test-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
const REG_PATH = path.join(tmpHome, '.ecode', 'server.json')
const LOCK_PATH = path.join(tmpHome, '.ecode', 'daemon-spawn.lock')
// 单测内打桩 REG/LOCK 路径：daemon.ts 以 homedir() 为基——USERPROFILE 覆盖（process 级）不可行（并行污染），
// 故直接对模块内常量打桩：用 vi.mock 不可行（常量非导出）——改为把 daemon.ts 的 REG/LOCK 路径改为可注入。
// 本测试采用「临时改写用户目录环境」的最小副作用方案：chdir 不动，仅断言纯函数。

import { daemonName, ensureDaemonAttach, writeServerRegAtomic, readServerReg, setDaemonHomeForTest, acquireSpawnLock, releaseSpawnLock, resurrectDaemonReg } from '../../src/cli/daemon.js'

// 2026-09-02 实证修复：原「USERPROFILE/HOME env 覆盖」隔离在 vitest worker 内不可靠——真机
// 复现跑本文件会把真实 ~/.ecode/server.json 覆盖成假注册（毁掉在跑 daemon 的注册 → 下次启动
// 误判重拉双 daemon）。改走显式注入（setDaemonHomeForTest），彻底绕开 env 时序/缓存。
setDaemonHomeForTest(tmpHome)

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
  // 注册/锁路径已由模块顶层 setDaemonHomeForTest(tmpHome) 显式注入（见上——env 覆盖不可靠）
  beforeEach(() => {})

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

describe('2026-09-02 自愈链：拉起锁与 resurrectDaemonReg', () => {
  setDaemonHomeForTest(tmpHome)

  const noopLogger = { info: () => {}, warn: () => {} }

  it('acquireSpawnLock：无锁→持锁→释放幂等；新锁互斥；stale 锁（kill -9 残留）龄检抢回', () => {
    // 无锁 → 持锁
    expect(acquireSpawnLock()).toBe(true)
    expect(fs.existsSync(LOCK_PATH)).toBe(true)
    // 新锁（他方在拉）→ 不抢
    expect(acquireSpawnLock()).toBe(false)
    // 释放幂等（未持锁也安全）
    releaseSpawnLock()
    releaseSpawnLock()
    expect(fs.existsSync(LOCK_PATH)).toBe(false)
    // stale 锁：mtime 推到 READY_TIMEOUT 之前 → 龄检抢删重取（残锁不再让自愈永远干等）
    fs.writeFileSync(LOCK_PATH, '')
    const stale = new Date(Date.now() - 60_000)
    fs.utimesSync(LOCK_PATH, stale, stale)
    expect(acquireSpawnLock()).toBe(true)
    releaseSpawnLock()
  })

  it('resurrectDaemonReg：他方持锁（不 spawn）+假 health 四验过 → 返回 reg 复用（真实注册路径）', async () => {
    const realVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    const health = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: 'i3', version: realVersion }))
    })
    await new Promise<void>((r) => health.listen(12401, '127.0.0.1', r))
    writeServerRegAtomic({ id: 'i3', port: 12401, token: 'tk3', pid: process.pid, version: realVersion, name: '复用机' })
    // 预置"他方持锁"（新 mtime）→ resurrect 不 spawn，纯轮询注册四验
    fs.writeFileSync(LOCK_PATH, '')
    try {
      const reg = await resurrectDaemonReg(noopLogger)
      expect(reg).toMatchObject({ id: 'i3', port: 12401, token: 'tk3', name: '复用机' })
    } finally {
      releaseSpawnLock()
      health.close()
      fs.rmSync(REG_PATH, { force: true })
    }
  }, 15_000)

  it('resurrectDaemonReg：stop 墓碑（5min 内）→ 尊重显式停止直接 null，不重拉', async () => {
    fs.writeFileSync(path.join(tmpHome, '.ecode', 'daemon.stopped'), JSON.stringify({ ts: Date.now() }))
    try {
      const reg = await resurrectDaemonReg(noopLogger)
      expect(reg).toBeNull()
      expect(fs.existsSync(LOCK_PATH)).toBe(false) // 未走拉起（墓碑在锁之前短路）
    } finally {
      fs.rmSync(path.join(tmpHome, '.ecode', 'daemon.stopped'), { force: true })
    }
  }, 10_000)

  it('resurrectDaemonReg：入口验活命中（SSE 抖动≠死亡）→ 不碰锁不 spawn 直接复用旧 reg', async () => {
    // 旧 daemon 其实活着：pid=本进程（活）+ 真 health 四验过。入口短路返回旧 reg，
    // 全程 LOCK 文件不出现（证明没走拉起/轮询路径）——R6 审阅挂账补录的回归锁。
    const realVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    const events: string[] = []
    const logger = { info: (_c: string, e: string) => events.push(e), warn: () => {} }
    const health = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: 'i4', version: realVersion }))
    })
    await new Promise<void>((r) => health.listen(12402, '127.0.0.1', r))
    writeServerRegAtomic({ id: 'i4', port: 12402, token: 'tk4', pid: process.pid, version: realVersion, name: '活体' })
    try {
      const reg = await resurrectDaemonReg(logger)
      expect(reg).toMatchObject({ id: 'i4', port: 12402, name: '活体' })
      expect(fs.existsSync(LOCK_PATH)).toBe(false) // 入口验活短路：锁从未创建
      expect(events).toContain('resurrect_skipped_alive')
    } finally {
      health.close()
      fs.rmSync(REG_PATH, { force: true })
    }
  }, 10_000)

  afterAll(() => {
    setDaemonHomeForTest(null) // 复位（防将来 isolate:false 跨文件泄漏）
  })
})
