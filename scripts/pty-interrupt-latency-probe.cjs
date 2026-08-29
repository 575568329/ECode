/**
 * Ctrl+C 中断迟滞探针（用户反馈「按一下要等一会才中断」的诊断）：
 *   假 SSE 慢流（Anthropic 流式格式，500ms/delta）驱动真机 TUI 流式轮次，
 *   流式中途单发 \x03，从 logstore 的 interrupt_latency_probe 四点插桩
 *   （pressed/received/surfaced/turn_finished）分段计时。
 * 输出：pressed→received（输入+信道）、received→surfaced（abort 浮现）、
 *       surfaced→turn_finished（轮收尾）、以及按键→UI 回空闲的墙钟对照。
 * 跑法：node scripts/pty-interrupt-latency-probe.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('D:/study/ECode/node_modules/node-pty')

const REPO = 'D:/study/ECode'
const DELTA_MS = 500
const N_DELTAS = 60
const MARK = '流速测试段落内容'

function startMock() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
    send('message_start', { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'mock-model' } })
    if (TOOL) {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ping -n 30 127.0.0.1"}' } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
      send('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    let i = 0
    const timer = setInterval(() => {
      if (i >= N_DELTAS) {
        clearInterval(timer)
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
        send('message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${MARK}${i} ` } })
      i += 1
    }, DELTA_MS)
    req.on('close', () => clearInterval(timer)) // 客户端 abort 即停
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function makeSandbox(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-interrupt-probe-'))
  fs.mkdirSync(path.join(dir, '.ecode'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.ecode', 'config.json'),
    JSON.stringify({
      providers: { mock: { type: 'anthropic', baseURL: `http://127.0.0.1:${port}`, apiKey: 'probe-key', models: ['mock-model'], contextWindow: 32000 } },
      current: { name: 'mock', model: 'mock-model' },
      maxIterations: 10, sandbox: { defaultMode: 'full-access' },
    }),
  )
  return dir
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REAL = process.argv.includes('--real')
const TOOL = process.argv.includes('--tool')
async function run() {
  const { server, port } = await startMock()
  const sandbox = makeSandbox(port)
  const proc = spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: REPO,
    env: REAL
      ? { ...process.env }
      : {
          ...process.env,
          USERPROFILE: sandbox,
          ECODE_BASE_URL: 'http://127.0.0.1:' + port,
          ECODE_MODEL: 'mock-model',
          ANTHROPIC_API_KEY: 'probe-key',
        },
  })
  let frame = ''
  proc.onData((d) => {
    frame += d
    if (frame.length > 30000) frame = frame.slice(-30000)
  })
  const has = (s) => frame.includes(s)

  // 1) 等 TUI 就绪 → 发 prompt
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL TUI 未就绪'); proc.kill(); server.close(); process.exit(1) }
  proc.write(REAL ? '详细介绍一下 TypeScript 的类型系统演进，从早期的 any 到现在的条件类型' : '随便说点什么长一点')
  await sleep(600)
  proc.write('\r')

  // 2) 等流式可见（首个 delta 文本出现）后再流 1.2s
  const streamSignal = REAL ? '（处理中' : (TOOL ? 'bash' : MARK)
  ok = false
  for (let i = 0; i < 200 && !ok; i++) { await sleep(100); ok = has(streamSignal) }
  if (!ok) { console.log('FAIL 流式未出现'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1200)

  // 3) 单发 Ctrl+C，计墙钟
  const tPress = Date.now()
  proc.write('\x03')

  // 4) 等 UI 回空闲（placeholder 复位）
  let tIdle = null
  for (let i = 0; i < 250 && tIdle === null; i++) {
    await sleep(100)
    if (has('输入消息，/help')) tIdle = Date.now()
  }
  const wallIdle = tIdle === null ? 'TIMEOUT' : `${tIdle - tPress}ms`

  await sleep(800) // 等 logstore flush
  proc.kill()
  server.close()

  // 5) 从最新日志取四点
  const logs = fs.readdirSync(path.join(REPO, '.ecode', 'logs')).filter((f) => f.endsWith('.jsonl')).sort((a, b) => fs.statSync(path.join(REPO, '.ecode', 'logs', b)).mtimeMs - fs.statSync(path.join(REPO, '.ecode', 'logs', a)).mtimeMs)
  const stages = {}
  for (const line of fs.readFileSync(path.join(REPO, '.ecode', 'logs', logs[logs.length - 1]), 'utf8').split('\n')) {
    if (!line.includes('interrupt_latency_probe')) continue
    try {
      const e = JSON.parse(line)
      stages[e.payload.stage] = new Date(e.ts).getTime()
    } catch { /* 忽略残行 */ }
  }
  const seg = (a, b) => (stages[a] !== undefined && stages[b] !== undefined ? `${stages[b] - stages[a]}ms` : '缺失')
  console.log('== Ctrl+C 中断迟滞分段 ==')
  console.log('按键→宿主收到   ', seg('pressed', 'received'))
  console.log('宿主收到→abort 浮现', seg('received', 'surfaced'))
  console.log('abort 浮现→轮收尾  ', seg('surfaced', 'turn_finished'))
  console.log('按键→UI 回空闲（墙钟）', wallIdle)
  fs.rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

run().catch((e) => { console.error(e); process.exit(1) })
