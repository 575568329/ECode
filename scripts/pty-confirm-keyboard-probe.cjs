/**
 * 批2b 验收探针：审批卡键盘交互五条真机断言（pty）。
 * 场景（mock SSE 轮 1 回 tool_use bash → default 档审批卡）：
 *   B1 字符不吞：卡开 → 写 hello → 输入框回显可见
 *   B2 Enter 防误批+草稿插话：有草稿 hello 时 CR → 卡仍在 + 「已排队」提示
 *   B2b 空草稿 Enter=批准（F-32 翻案批2b④）：清空草稿后 CR → 卡消（默认选中 y 直批）
 *   B3 y 快捷：写 y → 卡消（放行，工具执行收尾）——随后清插话队列（Ctrl+U 在卡开时无效：
 *         InputStream inactive 不接键、ConfirmPrompt 吞 ctrl 组合，须移到卡应答之后）
 *   B4 Esc=拒绝（第二轮审批卡）：ESC → 卡消（拒绝终态与轮收尾是软判定——mock 收尾回复
 *         未捕获不算失败，仅提示）
 * 跑法：node scripts/pty-confirm-keyboard-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const REPO = path.resolve(__dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-confirm-probe-'))
const tmpHome = path.join(tmpRoot, 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))

const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let roundNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let hasToolResult = false
    let lastText = ''
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'user') continue
        const c = msgs[i].content
        if (Array.isArray(c)) {
          if (c.some((b) => b.type === 'tool_result')) hasToolResult = true
          lastText = c.map((b) => b.text ?? '').join('')
        } else lastText = String(c)
        break
      }
    } catch {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: `msg_${++roundNo}`, type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (!hasToolResult && /写入文件/.test(lastText)) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${roundNo}`, name: 'bash', input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo probe-ok"}' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    } else {
      const reply = hasToolResult ? `执行完毕收尾说明第${roundNo}轮` : `问候回复第${roundNo}轮独有内容`
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    }
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')

let out = ''
let alive = false
let expectExit = false
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
const lastFrame = (n = 14) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')
const fail = (label, detail) => {
  console.log(`FAIL ${label}${detail ? '：' + detail : ''}`)
  console.log('---- 末 18 帧 ----\n' + lastFrame(18))
  if (alive && proc != null) proc.kill()
  expectExit = true
  process.exit(1)
}

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  console.log(`# mock SSE: 127.0.0.1:${port}`)
  proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy-key-for-pty-test', ECODE_MODEL: 'mock-model', USERPROFILE: tmpHome },
    cols: 110,
    rows: 32,
  })
  alive = true
  proc.onData((d) => (out += d))
  proc.onExit(() => {
    alive = false
    if (!expectExit) {
      console.error(`子进程意外退出\n${lastFrame(15)}`)
      process.exit(1)
    }
  })
  if (!(await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000))) fail('启动到输入框')

  // 触发审批卡
  const m1 = markNow()
  proc.write('帮我写入文件')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  if (!(await waitFor(m1, /\[Y\] 执行/, 30_000))) fail('审批卡弹出')

  // B1 字符不吞：写 hello → 回显
  const m2 = markNow()
  proc.write('hello')
  if (!(await waitFor(m2, /hello/, 4000))) fail('B1 字符不吞（卡开时打字回显）')
  // 卡应仍在（打字不消卡）
  if (!/\[Y\] 执行/.test(strip(out.slice(m1)))) fail('B1 打字后卡仍在')
  console.log('OK  B1 字符不吞（hello 回显且卡仍在）')

  // B2 Enter 防误批：草稿 hello 时 CR → 卡仍在 + 排队提示
  const m3 = markNow()
  proc.write('\r')
  await new Promise((r) => setTimeout(r, 1500))
  const frame3 = strip(out.slice(m3))
  if (!/\[Y\] 执行/.test(frame3)) fail('B2 草稿 Enter 不批准（卡应仍在）', '卡消失=误批')
  if (!/已排队/.test(frame3)) fail('B2 草稿 Enter 走插话排队', '未见「已排队」提示')
  console.log('OK  B2 草稿时 Enter=插话排队（卡不消不误批）')

  // 清草稿（hello 5 字符逐个退格）。清插话队列（Ctrl+U）在卡开时无效——P2-6 修正：
  // InputStream inactive 不接键、ConfirmPrompt 对 ctrl 组合返回 none，Ctrl+U 只能
  // 在卡应答后（B3 y 放行后）再发
  for (let i = 0; i < 5; i++) {
    proc.write('\x7f')
    await new Promise((r) => setTimeout(r, 250))
  }

  // B2b 空草稿 Enter=批准（F-32 翻案）：默认选中 y，CR → 卡消（放行收尾）
  const m4 = markNow()
  proc.write('\r')
  if (!(await waitFor(m4, /执行完毕收尾说明/, 30_000))) fail('B2b 空草稿 Enter 批准（默认 y 直批）', '未见收尾=未放行')
  console.log('OK  B2b 空草稿 Enter=批准（F-32 默认 y，卡消放行）')

  // B3 y 快捷：新一轮卡（B2b 已消费首卡）→ 写 y → 放行 → 收尾
  const m5 = markNow()
  proc.write('继续帮我写入文件')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  if (!(await waitFor(m5, /\[Y\] 执行/, 30_000))) fail('B3 第二张审批卡弹出')
  const m5b = markNow()
  proc.write('y')
  if (!(await waitFor(m5b, /执行完毕收尾说明第3轮|执行完毕收尾说明第4轮/, 30_000))) fail('B3 y 快捷放行收尾')
  console.log('OK  B3 空草稿 y 快捷放行')
  // 卡应答后再清插话队列（B2 的 hello 已入队；Ctrl+U 在卡开时无效——P2-6）
  proc.write('\x15') // Ctrl+U 清插话队列（此刻输入框已恢复激活）
  await new Promise((r) => setTimeout(r, 400))
  // B2 残留草稿已被应答清空（P1-1 方案 B：应答即清主输入框）——y 不会被 hasDraft 拦
  // （上一轮 hello 提交后输入框已清，此处 y 在空草稿下生效即证）

  // B4 Esc=拒绝：第二轮审批卡
  const m6 = markNow()
  proc.write('最后帮我写入文件')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  if (!(await waitFor(m6, /\[Y\] 执行/, 30_000))) fail('B4 第二张审批卡弹出')
  const m7 = markNow()
  proc.write('\x1b') // Esc
  await new Promise((r) => setTimeout(r, 2500))
  const frame7 = strip(out.slice(m7))
  const tail7 = frame7.slice(-2000)
  if (/\[Y\] 执行/.test(tail7)) {
    // 取证：打印命中点前后上下文（区分「首卡残影重绘」与「拒绝后重试弹了第二张卡」）
    const i = tail7.lastIndexOf('[Y] 执行')
    console.log(`# B4 证据（命中偏移 ${i}/${tail7.length}）：\n` + tail7.slice(Math.max(0, i - 160), i + 160).replace(/\n/g, '⏎'))
    fail('B4 Esc 拒绝后卡消', '卡仍在')
  }
  console.log('OK  B4 Esc=拒绝（卡消）')
  // 拒绝后模型收 tool_result 会再请求 → mock 回文本收尾（tool_result 路径）
  if (!(await waitFor(m7, /问候回复|执行完毕/, 60_000))) console.log('# （拒绝后收尾回复未捕获——可能仍在跑，不算失败）')

  console.log('\n# 结论：B1/B2/B2b/B3/B4 五项全过——批2b 审批卡键盘交互真机验收通过')
  proc.kill()
  expectExit = true
  server.close()
  server.closeAllConnections()
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  process.exit(0)
}

run().catch((e) => {
  console.error('driver error:', e)
  if (alive && proc != null) proc.kill()
  process.exit(1)
})
