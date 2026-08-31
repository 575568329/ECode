/**
 * F-38 中断提示真机探针：mock SSE 慢流（拖住轮次）→ Ctrl+C 中断 → 验证——
 *   ① 内容区无黄字横幅（ActivityBar aborted 已收敛）
 *   ② 「已中断，内容已保留」dim 提示出现（输入框上方）
 *   ③ 提示 5s TTL 后消失（帧上不再出现）
 * 跑法：node scripts/pty-interrupt-notice-probe.cjs
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

// 慢流：20 片 × 400ms（总 8s，足够在流中间按 Ctrl+C）
let finishStream = null
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    let i = 0
    const timer = setInterval(() => {
      i++
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `分段输出第${i}片。` } })
      if (i >= 20) {
        clearInterval(timer)
        sse('content_block_stop', { type: 'content_block_stop', index: 0 })
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } })
        sse('message_stop', { type: 'message_stop' })
        res.end()
      }
    }, 400)
    finishStream = () => { clearInterval(timer); res.end() }
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy-key-for-pty-test', ECODE_MODEL: 'mock-model' },
    cols: 90, rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)

  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(150); ok = has('输入消息') }
  if (!ok) { console.log('FAIL TUI 未就绪'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1500)
  proc.write('开始一个长任务')
  await sleep(600)
  proc.write('\r')

  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('分段输出第2片') }
  if (!ok) { console.log('FAIL 流未开始'); proc.kill(); server.close(); process.exit(1) }

  // === 关键动作：流中途 Ctrl+C ===
  const before = out.length
  proc.write('\x03')
  // 等 activity aborted 帧（流被 abort 后 loop 发 aborted）
  ok = false
  for (let i = 0; i < 60 && !ok; i++) { await sleep(200); ok = has('已中断，内容已保留') }
  const frameNow = strip(out.slice(before))
  console.log(ok ? 'OK   中断提示出现（dim 灰字非黄字横幅）' : 'FAIL 中断提示未出现')
  console.log(frameNow.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-14).join('\n'))

  // ① 黄字横幅不存在：ActivityBar aborted 文案不该以黄字形式出现在 spinner 行
  //    （文字本体允许出现在 systemMsgs 提示行——判定「⚠ 已中断，内容已保留」同框线组合）
  const badBanner = /⚠ 已中断，内容已保留/.test(strip(out))
  console.log(badBanner ? 'FAIL 仍存在 ⚠ 黄字横幅文本' : 'OK   无 ⚠ 黄字横幅')

  // ③ TTL 5s：提示消失——增量判定（Ink 只在重渲染时写输出，累积缓冲里旧行永远在；
  //    TTL 到期 setState 触发重绘，从当前时刻起的新增输出里不该再有提示行）
  const pos = out.length
  await sleep(6500)
  const delta = strip(out.slice(pos))
  console.log('=== delta 长度', delta.length, '===')
  console.log(delta.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-16).join('\n'))
  // 判定：pos 之后会先有一次 idle 化重绘（TTL 到期前重写提示行），TTL 到期后另有重绘——
  // 以「最后一次 idle 输入框占位出现」为界，其后不再有提示行 = TTL 生效
  const lastIdle = delta.lastIndexOf('输入消息，/help')
  const afterLastIdle = lastIdle >= 0 ? delta.slice(lastIdle) : delta
  console.log(afterLastIdle.includes('已中断，内容已保留') ? 'FAIL 提示 6.5s 后仍在（TTL 未生效）' : 'OK   提示 5s TTL 后消失（末次重绘无提示行）')

  proc.kill()
  server.close()
  setTimeout(() => process.exit(0), 200)
})
