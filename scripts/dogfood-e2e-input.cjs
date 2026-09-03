const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * 端到端 dogfood 探针（2026-08-31 输入体验批）：真轮次组合场景 + 服务端请求体捕获。
 * 与单点机制探针（input-clear/doublesc）的区别：断言「LLM 实收什么」——数据级验证，不只看 TUI 显示。
 *   A 大粘贴 token 化 → 提交 → mock server 收到全文（expandPasteRefs 数据级生效）
 *   B Ctrl+T 时间线：用户消息 ❯ + 粘贴全文可见；Ctrl+C 关闭回主界面（backToList 分流）
 *   C 双击 Esc 清空草稿 → 被清内容不发给 LLM；新消息正常送达
 *   D 会话落盘：历史文件里用户消息为展开后全文（token 不进持久化）
 * 跑法：node scripts/dogfood-e2e-input.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..')

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-dogfood-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-dogfood-cwd-'))

// mock SSE + 请求体捕获
const sse = (res, e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
const captured = [] // { userTexts: string[] } 每次请求最后一条 user 消息文本
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let lastUser = ''
    try {
      const j = JSON.parse(body)
      const msgs = Array.isArray(j.messages) ? j.messages : []
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          const c = msgs[i].content
          lastUser = typeof c === 'string' ? c : (c || []).map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n')
          break
        }
      }
    } catch { /* 非 JSON 请求忽略 */ }
    captured.push(lastUser)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `已收到第 ${captured.length} 条消息` } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
let out = ''
let mark = 0
let proc
const waitFor = (re, from, ms) => new Promise((r) => { const t0 = Date.now(); const id = setInterval(() => { if (re.test(strip(out.slice(from ?? 0)))) { clearInterval(id); r(true) } else if (Date.now() - t0 > ms) { clearInterval(id); r(false) } }, 120) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const check = (name, ok, extra) => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '\n     ' + extra : ''}`) }

  await waitFor(/ECode/, 0, 20000)
  await sleep(1500)

  // ===== A：大粘贴 token 化 → 提交 → LLM 收全文 =====
  const lines = Array.from({ length: 15 }, (_, i) => `数据行${String(i + 1).padStart(2, '0')}：内容甲乙丙丁`)
  mark = out.length
  proc.write(lines.join('\r'))
  await sleep(1200) // 聚合窗闭合 + retokenize 置换
  check('A1 输入框 token 化（[粘贴#1 +14 行]）', await waitFor(/粘贴#1 \+14 行/, mark, 4000))
  check('A2 原文不显示（数据行15 缺席）', !/数据行15/.test(strip(out.slice(mark))))
  proc.write('这段有几行')
  await sleep(400)
  proc.write('\r')
  check('A3 回复渲染', await waitFor(/已收到第 1 条消息/, mark, 15000))
  await sleep(800) // 轮收尾
  const got1 = captured[0] || ''
  check('A4 LLM 实收全文（数据行15 在）', got1.includes('数据行15：内容甲乙丙丁'))
  check('A5 LLM 实收不带 token 标签', !got1.includes('[粘贴#1'))
  check('A6 问题文本与粘贴共存', got1.includes('这段有几行'))

  // ===== B：Ctrl+T 时间线同构 =====
  mark = out.length
  proc.write('\x14') // Ctrl+T
  const opened = await waitFor(/时间线|Timeline/, mark, 4000)
  check('B1 时间线视图打开', opened)
  check('B2 用户消息 ❯ 前缀', /❯/.test(strip(out.slice(mark))))
  check('B3 粘贴全文可见（数据行15）', /数据行15：内容甲乙丙丁/.test(strip(out.slice(mark))))
  proc.write('\x03') // backToList 分流：Ctrl+T 直达 → Ctrl+C 关面板回主界面
  await sleep(800)
  proc.write('Z')
  await sleep(600)
  check('B4 Ctrl+C 关面板回主界面（❯ Z 落输入行）', /❯ Z/.test(strip(out.slice(mark))))
  proc.write('\x7f') // Backspace 清掉 Z
  await sleep(400)

  // ===== C：双击 Esc 清空草稿 → 被清内容不发给 LLM =====
  proc.write('这是被清掉的草稿XYZ')
  await sleep(600)
  proc.write('\x1b')
  await sleep(300)
  proc.write('\x1b')
  await sleep(1200)
  check('C1 草稿已清（占位符回归）', await waitFor(/输入消息，\/help 查看命令/, mark, 4000))
  proc.write('你好交个朋友')
  await sleep(400)
  proc.write('\r')
  check('C2 清空后正常对话', await waitFor(/已收到第 2 条消息/, mark, 15000))
  await sleep(800)
  const got2 = captured[1] || ''
  check('C3 被清草稿未发给 LLM', !got2.includes('被清掉的草稿'))
  check('C4 新消息正常送达', got2.includes('你好交个朋友'))

  // ===== D：会话落盘（历史为展开后全文） =====
  await sleep(1500) // 轮末落盘
  const sessDir = path.join(tmpHome, '.ecode', 'sessions')
  let persisted = ''
  try {
    for (const f of fs.readdirSync(sessDir)) if (f.endsWith('.jsonl')) persisted += fs.readFileSync(path.join(sessDir, f), 'utf8')
  } catch { /* 目录不存在则落盘断言失败 */ }
  check('D0 读到历史文件（空读=探针自身错，防 D2/D3 假绿）', persisted.length > 0)
  check('D1 历史落盘含粘贴全文', persisted.includes('数据行15：内容甲乙丙丁'))
  check('D2 历史无 token 残留', !persisted.includes('[粘贴#1'))
  check('D3 被清草稿未落盘', !persisted.includes('被清掉的草稿'))

  killPty(proc)
  server.close()
  const pass = checks.filter(Boolean).length
  console.log(`# 结论：端到端 dogfood ${pass}/${checks.length} ${pass === checks.length ? '全过' : '有失败'}`)
  process.exit(pass === checks.length ? 0 : 1)
}

run().catch((e) => { console.error('探针异常:', e); try { killPty(proc) } catch {} server.close(); process.exit(1) })
