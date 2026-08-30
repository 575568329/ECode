/**
 * 「突然停止连思考都不显示」复现探针（用户报障：别的设备、无现场日志）。
 *
 * 假设：第二轮请求 provider 静默空收尾（断流/端点异常返回空流但 SDK 不抛错）——
 * loop 零 delta 正常 end → finishTurn → UI 静默回 idle，无任何提示。
 *
 * 序列：R1 正常回复（建立对话）→ R2 prompt → mock 本轮回「合法空响应」（message_start+
 * stop 零 delta 零 tool_use）→ 观察 TUI 是否静默回输入态且无任何警告文本。
 * 跑法：node scripts/pty-empty-turn-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const REPO = path.resolve(__dirname, '..')

// 审阅 D5：会话/transcript 隔离到临时 home（mock 轮不再污染真实 ~/.ecode）
const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))

// 第 2 个请求（含'第二问'）回合法空响应；其余正常
const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let reqNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    reqNo++
    const isEmptyTurn = body.includes('第二问')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm' + reqNo, type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (!isEmptyTurn) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `第一问正常回复#${reqNo}` } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    }
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: isEmptyTurn ? 'end_turn' : 'end_turn', stop_sequence: null }, usage: { output_tokens: isEmptyTurn ? 0 : 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')

let out = ''
let proc = null
const waitFor = (mark, re, timeoutMs) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const id = setInterval(() => {
      if (re.test(strip(out.slice(mark)))) { clearInterval(id); resolve(true) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(id); resolve(false) }
    }, 120)
  })
const markNow = () => out.length
const lastFrame = (n = 16) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  console.log(`# mock SSE: 127.0.0.1:${port}（第二问将回合法空响应）`)

  proc = pty.spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    cwd: REPO,
    env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome, ANTHROPIC_API_KEY: 'dummy', ECODE_BASE_URL: `http://127.0.0.1:${port}`, ECODE_MODEL: 'mock-model' },
    cols: 110,
    rows: 32,
  })
  proc.onData((d) => (out += d))

  // R1 启动+第一问正常
  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 120_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} R1a 启动`)
    if (!ok) process.exit(1)
  }
  {
    const m = markNow()
    proc.write('第一问')
    await new Promise((r) => setTimeout(r, 600))
    proc.write('\r')
    const ok = await waitFor(m, /第一问正常回复/, 30_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} R1b 第一问正常回复渲染`)
    if (!ok) { console.log(lastFrame()); process.exit(1) }
  }
  await new Promise((r) => setTimeout(r, 1200))

  // R2 第二问 → mock 回空响应 → 观察 TUI 反应
  {
    const m = markNow()
    proc.write('第二问')
    await new Promise((r) => setTimeout(r, 600))
    proc.write('\r')
    // 观察 8s：输入提示是否回来（turn 结束）、期间有没有任何警告/错误文本
    const backIdle = await waitFor(m, /输入消息，\/help/, 15_000)
    const delta = strip(out.slice(m))
    const hasWarning = /(响应为空|空响应|异常|error|失败|⚠)/i.test(delta)
    console.log(`R2 空响应轮：turn 结束回输入态=${backIdle ? '是' : '否（还挂着）'}；期间出现警告/错误文本=${hasWarning ? '有' : '无'}`)
    console.log('---- R2 增量帧（去控制序列） ----')
    console.log(delta.split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-10).join('\n') || '(空)')
    console.log(`\n# 结论：${backIdle && !hasWarning ? '复现——空收尾轮静默结束，零提示（用户看到的「突然停止连思考都不显示」）' : '未按假设复现——见上方帧'}`)
    proc.kill()
    server.close()
    process.exit(0)
  }
}

run().catch((e) => {
  console.error('driver error:', e)
  if (proc != null) proc.kill()
  process.exit(1)
})
