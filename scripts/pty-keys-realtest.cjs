/**
 * 真机验证（技能第 5 层 pty）：回车提交 / Ctrl+J 换行 / Ctrl+C 中断思考轮。
 *
 * 形态：本地 mock Anthropic-SSE 服务（消息含"挂起"→吐首 delta 后挂住不收尾；
 * 否则正常一轮回完）+ pty 真跑 `npx tsx src/cli/index.ts`（TUI 全链路，含 Ink raw-mode）。
 * env 直注 ECODE_BASE_URL/ANTHROPIC_API_KEY(dummy)/ECODE_MODEL 重定向当前 provider 到 mock——
 * 不碰 ~/.ecode/config.json（只读），零 LLM 成本。
 *
 * 断言全部走增量帧（动作前打 mark，只看新增输出——pty 多帧叠加，memory 教训）。
 * 跑法：node scripts/pty-keys-realtest.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

// —— mock SSE 服务 —— //
const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body.includes('挂起') ? '开始思考' : '收到，这是回复' } })
    if (body.includes('挂起')) {
      // 真挂起：不收尾（模拟长思考），连接由客户端 abort 断开。
      // 坑：req 'close' 在 Node16+ 是「请求体读完」即触发——挂 res.end 会提前正常收尾，
      // 流根本没挂住（首跑 T4 假失败根因）
      return
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

// —— pty 驱动 —— //
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')

let out = ''
let proc = null
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '\n  ---- 增量帧 ----\n' + detail}`)
}
/** 轮询增量：从 mark 起的新输出里找文本 */
const waitFor = (mark, re, timeoutMs) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const id = setInterval(() => {
      if (re.test(strip(out.slice(mark)))) { clearInterval(id); resolve(true) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(id); resolve(false) }
    }, 150)
  })
const markNow = () => out.length
const lastFrame = (n = 12) =>
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

  // 1. 启动：输入框就绪（新快捷键提示含 Ctrl+J 换行）
  {
    const m = markNow()
    const ok = await waitFor(m, /Ctrl\+J 换行|输入消息/, 90_000)
    check('T1 启动到输入框', ok, lastFrame(15))
  }

  // 2. Ctrl+J 换行：两行同框（输入框多行渲染）
  {
    const m = markNow()
    proc.write('第一行')
    await new Promise((r) => setTimeout(r, 700))
    proc.write('\n') // Ctrl+J
    await new Promise((r) => setTimeout(r, 700))
    proc.write('第二行')
    await new Promise((r) => setTimeout(r, 700))
    const inc = strip(out.slice(m))
    check('T2 Ctrl+J 换行（两行都在输入框）', /第一行/.test(inc) && /第二行/.test(inc), inc.slice(-400))
  }

  // 3. 回车提交：mock 正常回一轮（conpty 回车 submit 实证点）
  {
    const m = markNow()
    proc.write('\r')
    const ok = await waitFor(m, /收到，这是回复/, 30_000)
    check('T3 回车提交 → 回复渲染', ok, lastFrame(15))
  }

  // 4. Ctrl+C 中断：挂起思考轮 → \x03 → 已中断 + placeholder 恢复
  {
    const m1 = markNow()
    proc.write('长任务挂起')
    await new Promise((r) => setTimeout(r, 700))
    proc.write('\r')
    const flowing = await waitFor(m1, /开始思考/, 30_000)
    if (!flowing) check('T4a 挂起轮 delta 到达', false, lastFrame(15))
    else {
      const m2 = markNow()
      proc.write('\x03')
      const aborted = await waitFor(m2, /已中断/, 15_000)
      const back = aborted ? await waitFor(m2, /输入消息/, 5_000) : false
      check('T4 Ctrl+C 中断（已中断 + 输入框恢复）', aborted && back, strip(out.slice(m2)).slice(-500))
    }
  }

  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`)
  if (proc != null) proc.kill()
  server.closeAllConnections()
  process.exit(failed.length > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('driver error:', e)
  if (proc != null) proc.kill()
  process.exit(1)
})
