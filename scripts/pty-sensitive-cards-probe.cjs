const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * D9 回归探针（2026-08-31 走查）：并行只读批次的多张 sensitive 卡必须串行出现在桌面上。
 * 此前缺陷：两张卡同时挂起，TUI 审批卡单槽——后帧顶掉前帧且不再渲染，未应答挂起悬空
 * 至审批超时（900s），整轮假死且 Ctrl+C 无法收敛。
 * 断言：
 *   S1 第一张 sensitive 卡出现（指纹「读取敏感路径」）
 *   S2 应答 y 后，第二张卡出现（串行化核心断言——修复前此处永不出现）
 *   S3 应答 y 后轮正常完成（mock 收尾文本）
 * 跑法：node scripts/pty-sensitive-cards-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const REPO = path.resolve(__dirname, '..')

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-cwd-'))
fs.writeFileSync(path.join(cwd, '.env.alpha'), 'A=1\n')
fs.writeFileSync(path.join(cwd, '.env.beta'), 'B=2\n')

const sse = (res, e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
let reqNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    reqNo++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查两个环境文件：' } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    if (reqNo === 1) {
      // 轮 1：同一批两个 read_file（.env.* 触发 sensitive 卡）——并行只读批次
      sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'ta', name: 'read_file' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: '.env.alpha' }) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
      sse(res, 'content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tb', name: 'read_file' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: '.env.beta' }) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 2 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
      sse(res, 'message_stop', { type: 'message_stop' })
    } else {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '两个文件都看完了。' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
      sse(res, 'message_stop', { type: 'message_stop' })
    }
    res.end()
  })
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
let out = ''
let mark = 0
const waitFor = (re, from, ms) => new Promise((r) => { const t0 = Date.now(); const id = setInterval(() => { if (re.test(strip(out.slice(from ?? 0)))) { clearInterval(id); r(true) } else if (Date.now() - t0 > ms) { clearInterval(id); r(false) } }, 120) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let proc
const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  proc = pty.spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'src', 'cli', 'index.ts')], {
    cwd,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 40,
  })
  proc.onData((d) => (out += d))
  const checks = []
  const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  await waitFor(/ECode/, 0, 20000)
  await sleep(1500)
  proc.write('检查环境文件')
  await sleep(300)
  proc.write('\r')

  // S1 第一张卡
  mark = out.length
  check('S1 第一张 sensitive 卡出现', await waitFor(/读取敏感路径/, mark, 20000))
  await sleep(600) // 留出渲染稳定（防第二张同刻渲染的误判——串行化后不可能）

  // S2 应答 y 后第二张卡出现
  mark = out.length
  proc.write('y')
  check('S2 y 后第二张卡出现（串行化）', await waitFor(/读取敏感路径/, mark, 8000))
  await sleep(600)

  // S3 应答 y 后轮完成
  mark = out.length
  proc.write('y')
  check('S3 轮完成（收尾文本）', await waitFor(/两个文件都看完了/, mark, 20000))

  killPty(proc)
  server.close()
  const pass = checks.every(([, ok]) => ok)
  if (!pass) {
    console.log('---- 屏幕现场（strip 末 40 行）----')
    console.log(strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-40).join('\n'))
  }
  console.log(pass ? '# 结论：sensitive 卡串行化全过' : '# 结论：存在失败项')
  process.exit(pass ? 0 : 1)
}
run().catch((e) => { console.error(e); try { killPty(proc) } catch {} server.close(); process.exit(1) })
