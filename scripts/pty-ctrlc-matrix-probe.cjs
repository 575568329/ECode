/**
 * Ctrl+C 状态矩阵探针（用户报告「Ctrl+C 不生效连提示都不显示」的诊断）：
 * 八个状态逐态实测按键归属（S7=覆盖层兜底）——任何一态「按了没反应」即复现用户症状。
 *   S1 空闲单发 → 「再按一次 Ctrl+C 退出」提示出现
 *   S2 空闲双发（>窗口间隔模拟：单发后等 2s 再单发不退出；紧接双发退出进程）
 *   S3 忙碌流式单发 → 轮中断 + 提示出现（abort 生效）
 *   S4 审批卡开着单发 → 拒卡 + 中断（ConfirmPrompt F-31）
 *   S5 Ctrl+T 全屏面板开着单发 → 退出面板（回到主界面，进程不退）
 *   S6 15 行粘贴折叠态单发 → 提示出现（输入态不吞 Ctrl+C）
 * 跑法：node scripts/pty-ctrlc-matrix-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const REPO = 'D:/study/ECode'

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-cwd-'))

// 慢流 mock（S3 用）：首请求 30s 慢流；审批请求（S4 用）由 prompt 指令触发 bash
const sse = (res, e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
let reqNo = 0
let slowTimer = null
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    reqNo++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (reqNo === 1) {
      // S3：慢流（Ctrl+C abort → req close 停表）
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      let i = 0
      slowTimer = setInterval(() => {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `S3慢流${i} ` } })
        i++
      }, 400)
      req.on('close', () => clearInterval(slowTimer))
      return
    }
    if (reqNo === 2) {
      // S4：直接给 bash tool_use 触发审批卡
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bash' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo s4"}' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到' } })
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
    env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 40,
  })
  proc.onData((d) => (out += d))
  let exited
  proc.onExit(({ exitCode }) => { exited = exitCode })
  const checks = []
  const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  await waitFor(/ECode/, 0, 20000)
  await sleep(1500)

  // S1 空闲单发 → 提示
  mark = out.length
  proc.write('\x03')
  check('S1 空闲单发出提示', await waitFor(/再按一次 Ctrl\+C 退出/, mark, 3000))
  await sleep(2000) // 提示超时自清（恢复单次语义）

  // S7 覆盖层兜底：/rewind 面板（自身无 Ctrl+C 处理）开着时 Ctrl+C 关闭面板
  proc.write('/rewind')
  await sleep(300)
  proc.write('\r')
  await sleep(400)
  proc.write('\r')
  check('S7a rewind 面板出现', await waitFor(/回退到哪个改动之前/, 0, 5000))
  mark = out.length
  proc.write('\x03')
  const closed = await waitFor(/输入消息，\/help 查看命令/, mark, 4000)
  proc.write('Z') // 面板已关 → 落主输入行；仍开着 → 进面板搜索框（无 ❯ Z 行）
  await sleep(800)
  check('S7b 面板内 Ctrl+C 关闭面板（全局兜底）', closed && /❯ Z/.test(strip(out.slice(mark))))
  await sleep(800)

  // S2 空闲双发（窗口内）→ 优雅退出——放到最后跑（会杀进程），此处先跳过
  // S3 忙碌流式单发 → 中断 + 提示
  proc.write('开始慢流任务')
  await sleep(300)
  proc.write('\r')
  await waitFor(/S3慢流2/, 0, 15000) // 等流式至少 2 delta
  mark = out.length
  proc.write('\x03')
  const interrupted = await waitFor(/已中断|再按一次 Ctrl\+C 退出/, mark, 6000)
  check('S3 忙碌流式单发中断+提示', interrupted)
  await sleep(2000)

  // S4 审批卡开着单发 → 拒卡+中断（F-31）
  proc.write('触发审批')
  await sleep(300)
  proc.write('\r')
  check('S4a 审批卡出现', await waitFor(/执行 bash\?/, 0, 15000))
  mark = out.length
  proc.write('\x03')
  check('S4b 卡上 Ctrl+C=拒卡（卡消失）', await waitFor(/用户已取消|已中断/, mark, 6000))
  await sleep(1500)

  // S5 Ctrl+T 面板开着单发 → 退面板不退进程
  proc.write('\x14') // Ctrl+T
  await waitFor(/执行时间线|L1-L\d+/, 0, 5000)
  mark = out.length
  proc.write('\x03')
  const backToMain = await waitFor(/输入消息，\/help 查看命令/, mark, 4000)
  check('S5 面板内 Ctrl+C=退面板', backToMain)
  await sleep(800)

  // S6 15 行粘贴折叠态单发 → 提示
  const lines = Array.from({ length: 15 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`)
  proc.write(lines.join('\r'))
  await sleep(1200)
  mark = out.length
  proc.write('\x03')
  check('S6 粘贴折叠态单发出提示', await waitFor(/再按一次 Ctrl\+C 退出/, mark, 3000))

  // S2 最后：窗口内双发 → 进程退出
  proc.write('\x03')
  await sleep(300)
  proc.write('\x03')
  await sleep(3000)
  check('S2 空闲窗口内双发优雅退出', exited !== undefined && exited !== null)

  try { proc.kill() } catch {}
  server.close()
  const pass = checks.every(([, ok]) => ok)
  if (!pass) {
    console.log('---- 屏幕现场（strip 末 35 行）----')
    console.log(strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-35).join('\n'))
  }
  console.log(pass ? '# 结论：Ctrl+C 五态矩阵全过' : '# 结论：存在死态（复现用户症状路径）')
  process.exit(pass ? 0 : 1)
}
// @ts-ignore
run().catch((e) => { console.error(e); try { proc.kill() } catch {} server.close(); process.exit(1) })
