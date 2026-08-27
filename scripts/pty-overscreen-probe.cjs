/**
 * M14-V5 真机验收探针：超屏防护硬指标——全 会话字节流不出现 ESC[3J
 * （Ink 帧高 ≥ rows 时的全屏兜底会清 scrollback——用户视角=跳顶滚不动）。
 *
 * 场景（小终端高危组合）：单会话两阶段（resize 切窗——避免二次 spawn 的 conpty
 * AttachConsole 崩），每阶段三轮 80-delta 长流（每轮文本量 ~40 物理行 > 小窗行数）：
 *   O1 rows=18 小窗 → O3 rows=40 正常窗对照
 * 输入用 ASCII（中文经 pty/conpty 编码链不稳——wedge-probe 教训）。
 * 判定：原始字节流含 \x1b[3J = FAIL；\x1b[2J = WARN 复核（conpty 标题伴随 vs 真兜底）。
 * 跑法：node scripts/pty-overscreen-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let roundNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log(`# [mock] 收到请求 #${roundNo + 1}（body ${body.length}B）`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    roundNo++
    // 每轮唯一长文（loop-guard 复读指纹安全网 + 超屏量级：80 段 ≈ 32+ 物理行 > 18 行窗）
    const reply = `overscreen-pressure-paragraph-${roundNo} `.repeat(140) + `END-OF-R${roundNo}`
    const chunks = 80
    for (let i = 0; i < chunks; i++) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / chunks), Math.floor((reply.length * (i + 1)) / chunks)) } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop' })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()[0AB]/g, '')

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
const dumpTail = (n = 16) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  console.log(`# mock SSE: 127.0.0.1:${server.address().port}`)

  proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      ECODE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
      ECODE_MODEL: 'mock-model',
    },
    cols: 100,
    rows: 18,
  })
  proc.onData((d) => (out += d))
  let exited = false
  proc.onExit(() => (exited = true))

  await waitFor(0, /./, 15_000)
  await new Promise((r) => setTimeout(r, 1500))

  let ok = true
  const phase = async (label, rounds) => {
    for (let i = 1; i <= rounds; i++) {
      const m = markNow()
      proc.write(`long r${i}`)
      await new Promise((r) => setTimeout(r, 250)) // \r 必须单独 write（合并发被 TextInput 当粘贴内嵌——pty 教训）
      proc.write('\r')
      const done = await waitFor(m, new RegExp(`END-OF-R${roundNo + 1}`), 30_000)
      if (!done) {
        console.log(`FAIL ${label} 第${i}轮回复未到达（等待 END-OF-R${roundNo + 1}）`)
        console.log('---- 末 16 帧 ----\n' + dumpTail())
        ok = false
        return
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    const mEcho = markNow()
    proc.write('z')
    const echoed = await waitFor(mEcho, /z/, 4000)
    console.log(`${echoed ? 'OK  ' : 'FAIL'} ${label} 调度活（轮末回显）`)
    if (!echoed) ok = false
    const seg = out
    const j3 = seg.includes('\x1b[3J')
    const j2 = seg.includes('\x1b[2J')
    if (j3) { console.log(`FAIL ${label} 出现 ESC[3J（Ink 全屏兜底——scrollback 被清）`); ok = false }
    else console.log(`OK  ${label} 无 ESC[3J`)
    if (j2) {
      // 复核自动化：真兜底 = 2J 后紧跟 3J（Ink cleanTerminal 成串）；孤立 2J = 启动清屏/conpty 伴随（无害）
      const hits = [...seg.matchAll(/\x1b\[2J/g)].map((m) => m.index)
      const real = hits.filter((i) => seg.slice(i, i + 8).includes('\x1b[3J')).length
      console.log(`WARN ${label} ESC[2J ×${hits.length}（真兜底 ${real} / 孤立 ${hits.length - real}=启动清屏·conpty 伴随，无害）`)
      if (real > 0) ok = false
    }
  }

  await phase('O1 小窗 rows=18', 3)
  proc.resize(100, 40)
  await new Promise((r) => setTimeout(r, 800))
  await phase('O3 正常 rows=40', 3)
  if (exited) { console.log('FAIL 子进程意外退出'); ok = false }

  proc.kill()
  server.close()
  if (ok) { console.log('== 全过：超屏防护硬指标达成（全程无 ESC[3J）=='); process.exit(0) }
  console.log('== 存在失败项 ==')
  process.exit(2)
}

run()
