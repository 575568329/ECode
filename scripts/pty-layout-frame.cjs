/**
 * F-36 栅格真机帧眼验（一次性脚本）：mock SSE 回一段长中文 markdown（含代码块），
 * pty 起源码 TUI，轮末抓终帧——核对：assistant 正文 ● 槽、折行续行对齐第 2 列、无第 0 列裸文字。
 * 跑法：node scripts/pty-layout-frame.cjs
 * 隔离同 overscreen-probe：ECODE_BASE_URL/ECODE_MODEL env 直连 mock（不碰真实配置）。
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const LONG_MD = [
  '## 统一栅格验证',
  '',
  '这是一段很长的中文回复用来验证折行续行是否对齐第二列圆点下方，'.repeat(4),
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '```ts',
  'const grid = "第一列只放图标"',
  '```',
  '',
  '收尾一句话。',
].join('\n')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log(`# [mock] 收到请求（body ${body.length}B）`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const chunk of LONG_MD.match(/[\s\S]{1,40}/g) ?? []) {
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })
    }
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '')

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      ECODE_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
      ECODE_MODEL: 'mock-model',
    },
    cols: 60,
    rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)

  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL TUI 未就绪'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1500) // 与 overscreen-probe 同款缓冲：首帧渲染≠stdin 就绪（pretool 冷启动）
  proc.write('grid-check') // 文本与 \r 必须分开 write——合并发被 Ink 判为粘贴内嵌不提交（探针坑惯例）
  await sleep(600)
  proc.write('\r')
  ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('收尾一句话') }
  if (!ok) { console.log('FAIL 回复未到达'); console.log('===== TUI 输出 dump ====='); console.log(strip(out).slice(-2500)); proc.kill(); server.close(); process.exit(1) }
  await sleep(1200) // 等 commit 进 Static + 状态回 idle

  const frame = strip(out)
  const tail = frame.slice(frame.lastIndexOf('grid-check'))
  console.log('===== 真机终帧（60 列）=====')
  console.log(tail.split('\n').map((l) => l.replace(/\s+$/, '')).slice(0, 34).join('\n'))
  console.log('===== 判定 =====')
  const lines = tail.split('\n').map((l) => l.replace(/\s+$/, ''))
  let pass = true
  const IDLE_HINT = /输入消息|ECode ·|⏎ 发送|^❯/
  for (const l of lines) {
    const t = l.trim()
    if (t === '' || IDLE_HINT.test(l)) continue
    // 第 0 列非空（l === t）：正文行必须挂 ● 槽（●/代码框线行合法；strip 假象：光标定位
    // 序列被剥后块间会视觉挤行，真判定只看第 0 列是否顶格出现正文文字）
    if (l === t && !l.startsWith('●') && !l.startsWith('╭') && !l.startsWith('│') && !l.startsWith('╰') && /这是一段很长|收尾一句话|列表项|const grid|统一栅格验证/.test(l)) {
      console.log('FAIL 第 0 列裸文字：', JSON.stringify(l.slice(0, 40)))
      pass = false
    }
  }
  const contLine = lines.find((l) => /^  这是一段很长/.test(l))
  if (contLine !== undefined) console.log('OK   折行续行第 2 列：', JSON.stringify(contLine.slice(0, 24)))
  const headLine = lines.find((l) => /^● /.test(l))
  if (headLine !== undefined) console.log('OK   正文挂 ● 槽：', JSON.stringify(headLine.slice(0, 24)))
  else if (contLine === undefined) { console.log('FAIL 未找到 ● 槽正文行'); pass = false }
  console.log(pass ? '== 结论：正文栅格达标 ==' : '== 结论：栅格未达标 ==')
  proc.kill()
  server.close()
  setTimeout(() => process.exit(pass ? 0 : 1), 200)
})
