const fs = require('node:fs')
const os = require('node:os')
/** 一次性验证：插话轮内留痕（排队行→注入→轮末 commit）。跑法：node scripts/pty-interject-check.cjs */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..')

// 审阅 D5：会话/transcript 隔离到临时 home（mock 轮不再污染真实 ~/.ecode）
const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const sse = (res, e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
let slow = false
const seenRequests = []
const server = http.createServer((req, res) => {
  let body = ''
  console.log(`[mock] ${req.method} ${req.url}`)
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log(`[mock] body ${body.length}B`)
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      let last = ''
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          const c = msgs[i].content
          last = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : ''
          break
        }
      }
      seenRequests.push(`[req${seenRequests.length + 1} 末user] ${last.slice(0, 70).replace(/\n/g, '␤')}`)
    } catch {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    const fast = seenRequests.length >= 2 // 第二轮（插话注入后）快速回复，缩短验证等待
    const chunks = slow && !fast ? 6 : 1
    const reply = slow && !fast ? '长任务执行中……'.repeat(30) : '好的，完成了。'
    for (let i = 0; i < chunks; i++) {
      setTimeout(() => {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / chunks), Math.floor((reply.length * (i + 1)) / chunks)) } })
        if (i === chunks - 1) {
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
          sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
          sse(res, 'message_stop', { type: 'message_stop' })
          res.end()
        }
      }, 1000 + i * 1200)
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
    cols: 110, rows: 34,
  })
  proc.onData((d) => (out += d))
  await waitFor(/ECode/, 0, 20000)
  await new Promise((r) => setTimeout(r, 1500))
  // ① 提交会进入慢轮的任务（pty 回车翻案：\r 必须单独 write——合并写=粘贴内嵌不提交）
  slow = true
  proc.write('帮我跑个长任务')
  await new Promise((r) => setTimeout(r, 300))
  proc.write('\r')
  await waitFor(/长任务执行中/, out.length - 200, 15000)
  console.log(`OK  慢轮已启动（流式可见，mock 收到 ${seenRequests.length} 个请求）`)
  // ② 轮内插话
  const mark = out.length
  proc.write('记得用方案A处理')
  await new Promise((r) => setTimeout(r, 300))
  proc.write('\r')
  const queued = await waitFor(/已排队/, mark, 8000)
  console.log(`${queued ? 'OK ' : 'FAIL'} 插话即时留痕（排队行出现在对话区）`)
  if (queued) console.log('---- 排队行帧 ----\n' + strip(out.slice(mark)).split('\n').filter((l) => l.includes('已排队') || l.includes('❯')).slice(-3).join('\n'))
  // ③ 轮结束后插话文本应落转写：单 iter 轮走轮末兜底（裸文本新轮）；多 iter 轮走步间注入（F-35 包装）。
  // 两种路径转写都必须有插话的用户消息 + 后续助手回复
  await new Promise((r) => setTimeout(r, 12000))
  const all = strip(out)
  const trace = all.includes('记得用方案A处理') && all.includes('好的，完成了。')
  fs.writeFileSync('tmp-interject-dump.txt', all); console.log(`${trace ? 'OK ' : 'FAIL'} 轮末转写留痕（F-35 包装 user 消息随 commit 出现在对话区）`)
  if (!(queued && trace)) {
    console.log('---- mock 收到的 LLM 请求（末 user 消息）----')
    console.log(seenRequests.join('\n'))
    console.log('---- 末 25 行现场 ----')
    console.log(all.split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-25).join('\n'))
  }
  proc.kill()
  server.close()
  process.exit(queued && trace ? 0 : 1)
}
run().catch((e) => { console.error(e); process.exit(1) })
