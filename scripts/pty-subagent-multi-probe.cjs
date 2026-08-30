/**
 * F-46 多子代理并发真机探针：主循环单轮派两个 task（readonly 并行池 Promise.all）→
 * 面板列表出现两条子代理条目 → 回车逐个查看（dump 实拍格式化输出）。
 * mock：主请求含「并发」标记时回双 tool_use task；子请求回各自结论。
 * 跑法：node scripts/pty-subagent-multi-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '')

let mainCalls = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    const isSub = body.includes('独立子任务代理')
    if (isSub) {
      // 子代理：回带标记的结论（按 prompt 区分甲/乙）
      const which = body.includes('查甲') ? '甲' : '乙'
      sse('message_start', { type: 'message_start', message: { id: `sub-${which}`, type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `结论：${which}子代理完成` } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    mainCalls++
    if (mainCalls > 1) {
      // 主循环第二轮起（tool_result 回喂后）：文本收尾
      sse('message_start', { type: 'message_start', message: { id: 'main2', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '两路并发收尾' } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    mainCalls++
    // 主循环第一轮：单轮双 tool_use（readonly 并行）
    sse('message_start', { type: 'message_start', message: { id: 'main1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ta', name: 'task', input: {} } })
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"甲任务并发探针","prompt":"查甲","type":"explore"}' } })
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tb', name: 'task', input: {} } })
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"description":"乙任务并发探针","prompt":"查乙","type":"explore"}' } })
    sse('content_block_stop', { type: 'content_block_stop', index: 1 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO, env: { ...process.env, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' }, cols: 110, rows: 34,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL 未就绪'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1200)
  proc.write('并发探针跑起来')
  await sleep(500)
  proc.write('\r')
  ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(250); ok = has('甲子代理完成') && has('乙子代理完成') }
  if (!ok) {
    console.log('FAIL 双子代理结论未回流')
    console.log(strip(out).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-14).join('\n'))
    proc.kill(); server.close(); process.exit(1)
  }
  console.log('OK   双子代理并行完成且结论都回流')
  await sleep(500)
  const pos = out.length
  proc.write('\x14') // Ctrl+T
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = strip(out.slice(pos)).includes('回车 查看') }
  if (!ok) { console.log('FAIL Ctrl+T 未开面板'); proc.kill(); server.close(); process.exit(1) }
  // F-49：列表过滤后只显示本会话的甲/乙两条——等 1s 列表轮询把 meta 摘要刷出来
  ok = false
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(250)
    const lf = strip(out.slice(pos))
    ok = lf.includes('甲任务并发探针') && lf.includes('乙任务并发探针')
  }
  console.log(ok ? 'OK   面板列表同时含两条子代理条目' : 'FAIL 列表条目缺失')
  // 回车进子代理条目：列表顺序 = 最近工具调用（task×2）→ 子代理区（甲/乙）。
  // ↓×4 到第一个子代理条目（index 2 起），每个键间隔 250ms 防 escape 合并
  const pos2 = out.length
  for (let i = 0; i < 4; i++) {
    proc.write('\x1b[B')
    await sleep(250)
  }
  proc.write('\r')
  await sleep(1200)
  console.log('===== 查看器实拍（子代理条目，仅可读行）=====')
  console.log(strip(out.slice(pos2)).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /[A-Za-z0-9]/.test(l)).join('\n'))
  console.log('== 结论：' + (hasA && hasB ? '多子代理并发可见性通过 ==' : '存在失败 =='))
  proc.kill()
  server.close()
  setTimeout(() => process.exit(hasA && hasB ? 0 : 1), 200)
})
