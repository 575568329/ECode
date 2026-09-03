const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * F-46 真机探针：busy 中（bash 长命令运行）按 Ctrl+T → 输出面板打开（运行期看 transcript 的入口）。
 * 跑法：node scripts/pty-ctrlt-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const REPO = path.resolve(__dirname, '..')

// 审阅 D5：会话/transcript 隔离到临时 home（mock 轮不再污染真实 ~/.ecode）
const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
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
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ping -n 30 127.0.0.1 >/dev/null"}' } })
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO, env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' }, cols: 110, rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL 未就绪'); killPty(proc); server.close(); process.exit(1) }
  await sleep(1200)
  proc.write('跑个长命令')
  await sleep(500)
  proc.write('\r')
  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('执行 bash') }
  if (!ok) { console.log('FAIL 审批卡未弹出'); killPty(proc); server.close(); process.exit(1) }
  proc.write('y') // 应答审批（默认 y）——bash 真跑进入 busy
  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('调用 bash') }
  if (!ok) { console.log('FAIL 工具未开始'); killPty(proc); server.close(); process.exit(1) }
  console.log('OK   busy 中（bash 运行）')
  const pos = out.length
  proc.write('\x14') // Ctrl+T
  // 2026-09-03 拍板：Ctrl+T 落地两级根菜单（数字直达——旧「直落时间线」路径退役）
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = strip(out.slice(pos)).includes('详情查看') && strip(out.slice(pos)).includes('数字直达') }
  console.log(ok ? 'OK   busy 中 Ctrl+T 打开根菜单' : 'FAIL Ctrl+T 未打开根菜单')
  let allOk = ok
  await sleep(300)
  // 数字 1 直达时间线（根菜单第 1 项恒为时间线）
  const pos2 = out.length
  proc.write('1')
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = strip(out.slice(pos2)).includes('执行时间线（全部流程）') }
  console.log(ok ? 'OK   数字 1 直达执行时间线' : 'FAIL 数字直达未进时间线')
  allOk = allOk && ok
  // 审阅 P2 连带验证：busy 中当前轮可见（item/started 同步 messagesRef——曾只轮末同步=空时间线）
  let sawUser = false
  for (let i = 0; i < 25 && !sawUser; i++) { await sleep(200); sawUser = strip(out.slice(pos2)).includes('跑个长命令') }
  console.log(sawUser ? 'OK   busy 中时间线含当前轮用户消息' : 'WARN busy 中时间线未见当前轮（轮末才同步）')
  console.log(strip(out.slice(pos2)).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-12).join('\n'))
  killPty(proc)
  server.close()
  setTimeout(() => process.exit(allOk ? 0 : 1), 200)
})
