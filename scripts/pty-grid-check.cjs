/**
 * 栅格探针（2026-08-30 布局排查）：转写面各行首列位实测。
 * 场景：提交任务 → mock 回 tool_use(read_file) → 真实工具执行 → 助手文本（慢响应窗口内插话）。
 * 断言（strip 后的流内行）：
 *   G1 用户消息   ❯ 顶格第 0 列（无「 ❯」）
 *   G2 工具组头   ● 1 个工具（无 ●  双空格）
 *   G3 助手文本   ● 回复（内容第 2 列）
 *   G4 排队插话行 ❯ + 已排队标记
 * 跑法：node scripts/pty-grid-check.cjs
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
    if (reqNo === 1) {
      // 轮 1：tool_use（read_file 真实执行 package.json）→ 停 tool_use；响应放慢留插话窗口
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先看一下项目结构：' } })
      setTimeout(() => {
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tg1', name: 'read_file' } })
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"package.json"}' } })
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
      }, 2500)
    } else {
      // 轮 2+：快速文本收尾
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看完了，结论是纯 ESM。' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
    }
  })
})
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
let out = ''
const waitFor = (re, from, ms) => new Promise((r) => { const t0 = Date.now(); const id = setInterval(() => { if (re.test(strip(out.slice(from ?? 0)))) { clearInterval(id); r(true) } else if (Date.now() - t0 > ms) { clearInterval(id); r(false) } }, 150) })
const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 40,
  })
  proc.onData((d) => (out += d))
  await waitFor(/ECode/, 0, 20000)
  await new Promise((r) => setTimeout(r, 1500))
  proc.write('了解一下本项目')
  await new Promise((r) => setTimeout(r, 300))
  proc.write('\r')
  // 轮内窗口插话（req1 文本流出后、tool_use 前 2.5s 窗口）
  await waitFor(/先看一下项目结构/, out.length - 400, 10000)
  proc.write('记得对齐栅格')
  await new Promise((r) => setTimeout(r, 300))
  proc.write('\r')
  // 等 tool_use 执行后的第二轮文本收尾
  await waitFor(/看完了/, out.length - 400, 20000)
  const all = strip(out)
  const lines = all.split('\n').map((l) => l.replace(/\r/g, ''))
  const checks = []
  const has = (re) => lines.some((l) => re.test(l))
  // G1 用户消息：❯ 顶格（存在 '❯ 了解一下本项目' 行，且不存在 ' ❯ 了解一下' 前导空格形态）
  checks.push(['G1 用户消息 ❯ 顶格', has(/^❯ 了解一下本项目/) && !has(/ ❯ 了解一下本项目/)])
  // G2 工具组头：● 后单空格（无 ●  双空格形态）
  checks.push(['G2 组头 ● 1 个工具', has(/● 1 个工具/) && !has(/●  1 个工具/)])
  // G3 助手文本：● 后单空格
  checks.push(['G3 助手 ● 看完了', has(/● 看完了/) && !has(/●  看完了/)])
  // G4 排队插话行
  checks.push(['G4 排队行 ❯+已排队', has(/^❯ .+已排队/) ])
  let pass = true
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
    if (!ok) pass = false
  }
  if (!pass) {
    console.log('---- 相关行现场 ----')
    console.log(lines.filter((l) => /❯|●/.test(l)).slice(-14).join('\n'))
  }
  proc.kill()
  server.close()
  process.exit(pass ? 0 : 1)
}
run().catch((e) => { console.error(e); process.exit(1) })
