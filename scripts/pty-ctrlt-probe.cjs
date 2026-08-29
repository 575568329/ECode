/**
 * F-46 真机探针：busy 中（bash 长命令运行）按 Ctrl+T → 输出面板打开（运行期看 transcript 的入口）。
 * 跑法：node scripts/pty-ctrlt-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    sse('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } })
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ping -n 30 127.0.0.1 >nul"}' } })
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO, env: { ...process.env, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' }, cols: 110, rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL 未就绪'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1200)
  proc.write('跑个长命令')
  await sleep(500)
  proc.write('\r')
  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('执行 bash') }
  if (!ok) { console.log('FAIL 审批卡未弹出'); proc.kill(); server.close(); process.exit(1) }
  proc.write('y') // 应答审批（默认 y）——bash 真跑进入 busy
  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('调用 bash') }
  if (!ok) { console.log('FAIL 工具未开始'); proc.kill(); server.close(); process.exit(1) }
  console.log('OK   busy 中（bash 运行）')
  const pos = out.length
  proc.write('\x14') // Ctrl+T
  // 判定用 PanelShell 底部提示（面板专有文本）——「输出」会误命中状态栏 Ctrl+T 提示
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = strip(out.slice(pos)).includes('q/Esc/Ctrl+C 退出') }
  console.log(ok ? 'OK   busy 中 Ctrl+T 打开输出面板' : 'FAIL Ctrl+T 未打开面板')
  console.log(strip(out.slice(pos)).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-12).join('\n'))
  proc.kill()
  server.close()
  setTimeout(() => process.exit(ok ? 0 : 1), 200)
})
