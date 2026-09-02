/**
 * 楔死专项探针（开放 P0：流式轮结束后 reconciler 永久楔死）。
 *
 * 已知特征（memory tui-streaming-turn-wedge）：有限流式轮正常收尾即复现——最后一帧渲染后
 * React 永不再渲染、stdin 不再处理（连退出键都失灵）、定时器活、CPU 0%。
 *
 * 判定序列（加压：长流 80 delta + 三连轮 + 每轮末回显探针）：
 *   W1 启动 → 输入框就绪
 *   W2 基线轮（消息A→回复AAA）→ 轮末回显探针
 *   W3 长流轮（80 delta）→ 轮末回显探针
 *   W4/W5 再两轮完整渲染（调度链全程健康判定）
 * 回显探针=写 'x' 看输入框回显新帧（stdin 处理死=楔死实锤）；探针字符退格清掉。
 * 跑法：node scripts/pty-wedge-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let roundNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    // 每轮唯一回复（loop-guard 复读指纹安全网会把重复输出当故障熔断——探针自身别触发它）
    // 判定依据=最后一条 user 消息（请求 body 含全量历史——includes 全 body 会把 W3 的
    // "长流"留在后续每轮历史里，第 3 轮起判定恒真——曾致探针等错串假失败）
    let last = body
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          const c = msgs[i].content
          last = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : ''
          break
        }
      }
    } catch {}
    roundNo++
    let reply = `这是第${roundNo}轮唯一回复`
    let chunks = 3
    if (last.includes('长流')) { reply = `长流压力测试内容段落。`.repeat(20) + `（第${roundNo}轮长流尾部）`; chunks = 80 }
    for (let i = 0; i < chunks; i++) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / chunks), Math.floor((reply.length * (i + 1)) / chunks)) } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
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
const lastFrame = (n = 14) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  console.log(`# mock SSE: 127.0.0.1:${port}`)

  proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      ECODE_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
      ECODE_MODEL: 'mock-model',
      ECODE_FORCE_EMBEDDED: '1', // T 线后防自动附着运行中 daemon（轮次跑 daemon 进程=无 mock env → 打真端点）
    },
    cols: 110,
    rows: 32,
  })
  proc.onData((d) => (out += d))
  proc.onExit(({ exitCode }) => {
    console.error(`子进程意外退出 code=${exitCode}\n末尾帧:\n${lastFrame(15)}`)
    process.exit(1)
  })

  /** 轮末回显探针：写 'x' 看回显；失败=楔死实锤（末帧+CPU 差分留证）后 exit 2 */
  const echoProbe = async (label) => {
    const m = markNow()
    proc.write('x')
    const echoed = await waitFor(m, /x/, 4000)
    console.log(`${echoed ? 'OK  调度活' : 'FAIL 楔死实锤'} ${label}`)
    if (!echoed) {
      console.log('---- 楔死现场末 20 帧 ----\n' + lastFrame(20))
      try {
        const { execSync } = require('node:child_process')
        const pid = proc.pid
        const c1 = execSync(`powershell -c "(Get-Process -Id ${pid}).CPU"`).toString().trim()
        await new Promise((r) => setTimeout(r, 2000))
        const c2 = execSync(`powershell -c "(Get-Process -Id ${pid}).CPU"`).toString().trim()
        console.log(`# CPU 差分: ${c1} -> ${c2}（不变=静默死锁）`)
      } catch {}
      process.exit(2)
    }
    proc.write('\x7f')
    await new Promise((r) => setTimeout(r, 400))
  }

  /** 发一条消息并等回复片段 */
  const round = async (label, text, expect) => {
    const m = markNow()
    proc.write(text)
    await new Promise((r) => setTimeout(r, 600))
    proc.write('\r')
    const ok = await waitFor(m, expect, 30_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} ${label}`)
    if (!ok) { console.log(lastFrame(16)); process.exit(1) }
    await new Promise((r) => setTimeout(r, 1500))
  }

  // W1 启动
  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} W1 启动到输入框`)
    if (!ok) { console.log(lastFrame()); process.exit(1) }
  }
  await round('W2 基线轮渲染', '消息A', /这是第1轮唯一回复/)
  await echoProbe('W2b 基线轮末回显')
  await round('W3 长流轮（80 delta）渲染', '长流压力', /长流压力测试内容段落/)
  await echoProbe('W3b 长流轮末回显')
  await round('W4 第三轮渲染', '消息C', /这是第3轮唯一回复/)
  await echoProbe('W4b 第三轮末回显')
  await round('W5 第四轮渲染', '消息D', /这是第4轮唯一回复/)

  console.log('\n# 结论：4 轮（含 80-delta 长流）+ 3 次轮末探针全过——未复现楔死')
  proc.kill()
  server.close()
  server.closeAllConnections()
  process.exit(0)
}

run().catch((e) => {
  console.error('driver error:', e)
  if (proc != null) proc.kill()
  process.exit(1)
})
