/**
 * F-46 子代理完整链真机探针：主循环派 task → 子代理执行（事件行落盘）→ 完成 →
 * Ctrl+T 打开面板 → 面板列表含子代理条目 → 回车进入查看器 → 帧出现格式化内容。
 * mock 按请求区分主/子：子代理 system 含「独立子任务代理」→ 回结论文本；否则回 tool_use task。
 * 跑法：node scripts/pty-subagent-probe.cjs
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

let mainCalls = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    const isSub = body.includes('独立子任务代理')
    if (isSub) {
      // 子代理：直接回结论（一轮）
      sse('message_start', { type: 'message_start', message: { id: 'sub1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '结论：子代理探针完成' } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    // 主循环：第 1 次回 tool_use task（派子代理）；之后回文本收尾（防无限派）
    mainCalls++
    if (mainCalls > 1) {
      sse('message_start', { type: 'message_start', message: { id: `main${mainCalls}`, type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '主循环收尾' } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    sse('message_start', { type: 'message_start', message: { id: 'main1', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'task', input: {} } })
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"子代理探针任务","prompt":"随便查一下","type":"general"}' } })
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
  if (!ok) { console.log('FAIL 未就绪'); proc.kill(); server.close(); process.exit(1) }
  await sleep(1200)
  proc.write('派个子代理')
  await sleep(500)
  proc.write('\r')
  // task 工具 readonly:true 免确认（并行池设计）——直接等子代理跑完+结论回流
  ok = false
  for (let i = 0; i < 80 && !ok; i++) { await sleep(250); ok = has('子代理探针完成') }
  if (!ok) { console.log('FAIL 子代理结论未回流'); proc.kill(); server.close(); process.exit(1) }
  console.log('OK   子代理跑完且结论回流主循环')
  await sleep(500)
  // Ctrl+T → 面板
  const pos = out.length
  proc.write('\x14')
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = strip(out.slice(pos)).includes('回车 查看') }
  if (!ok) { console.log('FAIL Ctrl+T 未开面板'); proc.kill(); server.close(); process.exit(1) }
  console.log('OK   Ctrl+T 打开输出面板')
  // 面板列表：子代理条目（唯一 description 摘要）
  ok = strip(out.slice(pos)).includes('子代理探针任务')
  // 判定（F-49）：摘要=meta description（终态重写保留 meta 首行）；currentSid 过滤后
  // 本会话子代理可见、跨会话条目不出现
  ok = strip(out.slice(pos)).includes('子代理探针任务')
  console.log(ok ? 'OK   面板列表含本子代理条目（实时刷新生效）' : 'FAIL 面板列表未见子代理条目')
  console.log('# 列表 dump:')
  console.log(strip(out.slice(pos)).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /§|transcript/.test(l)).join('\n'))
  // 回车进查看器 → 格式化内容
  const pos2 = out.length
  proc.write('\r')
  ok = false
  for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = /▶ user: 查甲|结论：子代理探针完成/.test(strip(out.slice(pos2))) }
  // 实拍：查看器内容行（人工核对格式）
  console.log('===== 查看器实拍（仅可读行）=====')
  console.log(strip(out.slice(pos2)).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /[A-Za-z0-9\u4e00-\u9fff]/.test(l)).join('\n'))
  console.log(ok ? 'OK   查看器渲染格式化 transcript' : 'FAIL 查看器无格式化内容')
  if (!ok) console.log(strip(out.slice(pos2)).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-12).join('\n'))
  proc.kill()
  server.close()
  setTimeout(() => process.exit(ok ? 0 : 1), 200)
})
