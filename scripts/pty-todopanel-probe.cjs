/**
 * TodoPanel 集成实测：mock SSE 让模型调用 todo 工具 → 观察输入区上方常驻面板
 * （头部完成度 + ASCII 状态符逐项清单）。对标 CC/harness/opencode「清单不进对话流」。
 * 跑法：node scripts/pty-todopanel-probe.cjs
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

const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let reqNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    reqNo++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm' + reqNo, type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (reqNo === 1) {
      // 第一轮：模型调 todo 工具（全量清单）
      const todos = JSON.stringify({ todos: [{ content: '读配置模板', status: 'completed' }, { content: '同步手册', status: 'in_progress' }, { content: '回归测试', status: 'pending' }] })
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'todo' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: todos } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } })
    } else {
      // 第二轮：收尾文本
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '清单已建立' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    }
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
const lastFrame = (n = 16) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  proc = pty.spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ANTHROPIC_API_KEY: 'dummy', ECODE_BASE_URL: `http://127.0.0.1:${port}`, ECODE_MODEL: 'mock-model' },
    cols: 110,
    rows: 32,
  })
  proc.onData((d) => (out += d))

  const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 120_000)
  console.log(`${ok ? 'OK ' : 'FAIL'} T1 启动`)
  if (!ok) process.exit(1)
  const m = markNow()
  proc.write('建个任务清单')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  const done = await waitFor(m, /清单已建立/, 30_000)
  console.log(`${done ? 'OK ' : 'FAIL'} T2 轮完成（todo 调用+收尾文本）`)
  await new Promise((r) => setTimeout(r, 1200))
  const tail = strip(out.slice(m)).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-14).join('\n')
  const hasPanel = /任务清单/.test(tail) && /1\/3 完成/.test(tail)
  const hasItems = /\[x\] 读配置模板/.test(tail) && /\[->\] 同步手册/.test(tail) && /\[ \] 回归测试/.test(tail)
  const notInFlow = !/todo/.test(tail.split('任务清单')[0] ?? '') // 清单不再以工具行出现在对话流
  console.log(`${hasPanel ? 'OK ' : 'FAIL'} T3 常驻面板出现（任务清单 1/3 完成）`)
  console.log(`${hasItems ? 'OK ' : 'FAIL'} T4 逐项 ASCII 状态符渲染`)
  console.log('---- 末帧 ----\n' + lastFrame(14))
  console.log(`\n# 结论：${hasPanel && hasItems ? 'TodoPanel 集成实证通过' : '见上方帧排查'}`)
  proc.kill()
  server.close()
  process.exit(hasPanel && hasItems ? 0 : 1)
}

run().catch((e) => {
  console.error('driver error:', e)
  if (proc != null) proc.kill()
  process.exit(1)
})
