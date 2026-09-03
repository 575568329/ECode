const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * 子代理进度行显示形态观测探针（2026-08-30 用户问「子代理一直显示 1s/ls 是什么」）：
 * 复现 SubagentBar 在「上一工具已返回、下一轮 LLM 还没响应」窗口期的显示——
 * mock 序列：子代理 R1 回 tool_use ls（免确认只读）→ R2 故意延迟 10s 才回 tool_use grep
 * → R3 再延迟 6s 回结论文本。每 1.5s 抓一次屏上含任务描述的行，按时间轴打印。
 * 跑法：node scripts/pty-subagent-display-probe.cjs
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

const DESC = '显示观测'
const R2_DELAY_MS = 10_000
const R3_DELAY_MS = 6_000

let mainCalls = 0
let subCalls = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    const begin = (id) => sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    const toolUse = (id, name, json) => {
      begin(id)
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `${id}-t`, name, input: {} } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
    }
    const text = (id, s) => {
      begin(id)
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
    }
    if (body.includes('独立子任务代理')) {
      // 子代理：R1 立即 ls → R2 延迟 10s 后 grep → R3 延迟 6s 后出结论
      subCalls++
      if (subCalls === 1) return toolUse('sub1', 'ls', '{"path":"src/tools"}')
      if (subCalls === 2) {
        await sleep(R2_DELAY_MS)
        return toolUse('sub2', 'grep', '{"pattern":"readonly","path":"src/tools"}')
      }
      await sleep(R3_DELAY_MS)
      return text('sub3', '结论：观测完成')
    }
    // 主循环：第 1 次派 task，之后收尾
    mainCalls++
    if (mainCalls > 1) return text(`main${mainCalls}`, '主循环收尾')
    return toolUse('main1', 'task', `{"description":"${DESC}","prompt":"随便查一下","type":"general"}`)
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO, env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' }, cols: 110, rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) { await sleep(150); ready = strip(out).includes('输入消息') }
  if (!ready) { console.log('FAIL 未就绪'); killPty(proc); server.close(); process.exit(1) }
  await sleep(1200)
  proc.write('派个子代理')
  await sleep(500)
  const t0 = Date.now()
  proc.write('\r')
  // 时间轴采样：每 1.5s 抓当前帧里含任务描述的最新一行（帧历史追加式，取最后一次出现=当前态）
  const lineOf = () => {
    const lines = strip(out).split('\n').map((l) => l.replace(/\s+$/, ''))
    const hits = lines.filter((l) => l.includes(DESC))
    return hits.length > 0 ? hits[hits.length - 1].trim() : '(无该行)'
  }
  let done = false
  for (let i = 0; i < 30 && !done; i++) {
    await sleep(1500)
    const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
    console.log(`t=${t}s :: ${lineOf()}`)
    done = strip(out).includes('主循环收尾')
  }
  await sleep(800)
  const ok = done
  console.log(ok ? 'OK   全程采样完成' : 'FAIL 未观察到收尾')
  killPty(proc)
  server.close()
  setTimeout(() => process.exit(ok ? 0 : 1), 200)
})
