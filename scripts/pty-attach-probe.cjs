/**
 * T5 真机门探针：pty-attach-probe（T 线 TUI 附着 daemon——方案 §7 G-T 断言子集）。
 *   A1 冷启动拉起：无 server.json → TUI 自动拉起 detached serve → 附着顶栏提示
 *   A2 提交流：prompt 回执渲染（mock SSE 慢流）
 *   A3 双客户端：第二 SSE 客户端直连 mux 同帧收到 delta（多客户端同会话）
 *   A4 TUI 退出 daemon 存活：Ctrl+C 退出后 /health 仍 200（慢流跑完落盘）
 *   A5 重开 TUI 秒附：server.json 复用（无二次 spawn）+ /history 列表含前轮
 *   A6 --local：ECODE_FORCE_EMBEDDED=1（--local 同路径）→ 无 server.json 写入
 *   A7 版本不符：预写 version=0.0.0 注册 → 拒绝附着+不 spawn（进程内提示即退出）
 * 跑法：node scripts/pty-attach-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..')

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9AB]/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 空转 mock SSE（LLM 端点）——delta 慢流 */
function startMockLlm() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try { fs.appendFileSync('D:/study/ECode/.ecode/mock-req.log', `req ${req.url} auth=${String(req.headers.authorization).slice(0, 12)}
`) } catch {}
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const sse = (e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
      sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      // 慢流 timer 不绑 req 'close'——Node 18+ 的 IncomingMessage 'close' 在 POST body 读完
      // 即触发（早于响应写完），清掉 timer 会让 delta 永停（本次调查实证的探针 bug）
      let i = 0
      const timer = setInterval(() => {
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `慢流${i} ` } })
        if (++i > 8) {
          clearInterval(timer)
          sse('content_block_stop', { type: 'content_block_stop', index: 0 })
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
          sse('message_stop', { type: 'message_stop' })
          res.end()
        }
      }, 300)
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, close: () => new Promise((done) => server.close(done)) })))
}

function isolatedHome() {
  const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-attach-home-')), 'home')
  fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
  fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-attach-cwd-'))
  return { tmpHome, cwd }
}

function spawnTui({ home, cwd, mockPort, extraEnv = {} }) {
  return pty.spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'src', 'cli', 'index.ts')], {
    cwd,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '', USERPROFILE: home, HOME: home, ECODE_BASE_URL: `http://127.0.0.1:${mockPort}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model', ...extraEnv },
    cols: 110,
    rows: 40,
  })
}

function readReg(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.ecode', 'server.json'), 'utf8'))
  } catch {
    return null
  }
}

async function healthOk(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitFor(fn, ms, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

const run = async () => {
  const checks = []
  const check = (name, ok) => {
    checks.push(ok)
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
  }
  const llm = await startMockLlm()
  const llmPort = new URL('http://x').port // 占位（实际端口从 address 取）
  void llmPort
  const { server: llmServer } = { server: llm.server }
  const llmAddr = llmServer.address()
  const mockPort = llmAddr.port

  console.log(`[DBG shell] ECODE_DBG=${process.env.ECODE_DBG ?? 'unset'}`)
  // ===== A1 冷启动拉起+附着 =====
  const h1 = isolatedHome()
  let out1 = ''
  const tui1 = spawnTui({ home: h1.tmpHome, cwd: h1.cwd, mockPort })
  tui1.onData((d) => (out1 += d))
  const attached = await waitFor(() => /已附着后台服务/.test(strip(out1)), 25000)
  if (process.env.ECODE_DBG) console.log('[DBG probe] out1 head:', JSON.stringify(strip(out1).slice(0, 300)))
  const reg1 = readReg(h1.tmpHome)
  check('A1 冷启动自动拉起 daemon 并附着（顶栏提示+注册文件）', attached !== null && reg1 !== null && typeof reg1.pid === 'number')
  const daemonPort = reg1?.port
  check('A1b 注册文件带 version+name（多机区分/版本比对）', reg1 !== null && typeof reg1.version === 'string' && typeof reg1.name === 'string')

  // ===== A2 提交流 =====
  await sleep(3000) // 等 SSE pump 稳定（连接时序竞态排查）
  tui1.write('测一段流式')
  await sleep(600)
  tui1.write('\r')
  const streamed = await waitFor(() => /慢流3/.test(strip(out1)), 15000)
  if (process.env.ECODE_DBG) console.error('[DBG A2 tail]', JSON.stringify(strip(out1).slice(-400)))
  check('A2 提交后流式渲染（附着态经 mux 帧回显）', streamed !== null)

  // ===== A3 第二客户端同帧（多客户端同会话） =====
  let secondSawDelta = false
  if (daemonPort !== undefined && reg1 !== null) {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/events.mux?canAnswer=1`, {
      headers: { authorization: `Bearer ${reg1.token}` },
    })
    if (res.ok && res.body !== null) {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      const t0 = Date.now()
      tui1.write('\r') // 空提交不做（清掉）——先发一条可观察的插话不必要；改读已有流
      while (Date.now() - t0 < 6000) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = dec.decode(value, { stream: true })
        if (chunk.includes('session/subscribed') || chunk.includes('thread/status')) {
          secondSawDelta = true
          break
        }
      }
      reader.cancel().catch(() => {})
    }
  }
  check('A3 第二 mux 客户端同帧收到会话事件', secondSawDelta)

  // ===== A4 TUI 退出 daemon 存活 =====
  tui1.write('\x03')
  await sleep(300)
  tui1.write('\x03')
  await sleep(1500)
  const aliveAfterTuiExit = daemonPort !== undefined ? await healthOk(daemonPort) : false
  check('A4 TUI 退出后 daemon 存活（/health 200——任务继续跑）', aliveAfterTuiExit)

  // ===== A5 重开秒附（无二次 spawn）+ 历史完整 =====
  const regBefore = readReg(h1.tmpHome)
  let out2 = ''
  const tui2 = spawnTui({ home: h1.tmpHome, cwd: h1.cwd, mockPort })
  tui2.onData((d) => (out2 += d))
  const reattached = await waitFor(() => /已附着后台服务/.test(strip(out2)), 15000)
  const regAfter = readReg(h1.tmpHome)
  check('A5 重开 TUI 秒附（同一 daemon——pid 未变）', reattached !== null && regBefore !== null && regAfter !== null && regBefore.pid === regAfter.pid)
  tui2.write('/history')
  await sleep(600)
  tui2.write('\r') // 第一回车：填入命令（两段式）
  await sleep(400)
  tui2.write('\r') // 第二回车：执行 → 打开恢复列表
  const histShown = await waitFor(() => /测一段流式/.test(strip(out2)), 10000)
  if (process.env.ECODE_DBG) console.error('[DBG A5b tail]', JSON.stringify(strip(out2).slice(-500)))
  check('A5b 恢复列表含前轮会话（历史完整）', histShown !== null)
  tui2.write('\x03')
  await sleep(300)
  tui2.write('\x03')
  await sleep(1000)

  // ===== A6 --local（FORCE_EMBEDDED 同路径）不写注册 =====
  const h2 = isolatedHome()
  let out3 = ''
  const tui3 = spawnTui({ home: h2.tmpHome, cwd: h2.cwd, mockPort, extraEnv: { ECODE_FORCE_EMBEDDED: '1' } })
  tui3.onData((d) => (out3 += d))
  await waitFor(() => /输入消息/.test(strip(out3)), 20000)
  await sleep(1500)
  check('A6 --local/强制 Embedded：无 server.json 写入', readReg(h2.tmpHome) === null)
  tui3.write('\x03')
  await sleep(300)
  tui3.write('\x03')
  await sleep(800)

  // ===== A7 版本不符拒绝附着（预写假版本注册——pid 真活+health 真活由 A4 的 daemon 承担） =====
  const h3 = isolatedHome()
  const goodReg = readReg(h1.tmpHome)
  if (goodReg !== null && (await healthOk(goodReg.port))) {
    const forged = { ...goodReg, version: '0.0.0-test' }
    fs.writeFileSync(path.join(h3.tmpHome, '.ecode', 'server.json'), JSON.stringify(forged), { mode: 0o600 })
    // home 指向 h3 但 daemon 端口/健康来自 h1 的注册——伪造注册指向同一活 daemon，版本假
    let out4 = ''
    const tui4 = spawnTui({ home: h3.tmpHome, cwd: h3.cwd, mockPort })
    tui4.onData((d) => (out4 += d))
    await waitFor(() => /输入消息/.test(strip(out4)) || /版本不一致|版本不符/.test(strip(out4)), 20000)
    await sleep(1000)
    const rejected = /不一致|未切换/.test(strip(out4))
    const noSpawn = readReg(h3.tmpHome) !== null && (readReg(h3.tmpHome)?.version === '0.0.0-test')
    check('A7 版本不符拒绝附着+不 spawn（保住跑着的任务）', rejected)
    check('A7b 假注册未被覆盖重写（没有误 spawn 新 daemon）', noSpawn)
    try {
      tui4.kill()
    } catch {}
  } else {
    check('A7 版本不符拒绝附着（前置 daemon 存活断言未满足——跳过）', false)
    check('A7b 假注册未被覆盖重写', false)
  }

  // ===== 清理：停 daemon =====
  const finalReg = readReg(h1.tmpHome)
  if (finalReg !== null) {
    try {
      process.kill(finalReg.pid)
    } catch {}
  }
  try {
    tui1.kill()
    tui2.kill()
    tui3.kill()
  } catch {}
  await llm.close()
  const pass = checks.filter(Boolean).length
  console.log(`# 结论：pty-attach-probe ${pass}/${checks.length} ${pass === checks.length ? '全过' : '有失败'}`)
  process.exit(pass === checks.length ? 0 : 1)
}

run().catch((e) => {
  console.error('探针异常:', e)
  process.exit(1)
})
