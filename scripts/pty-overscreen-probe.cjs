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
    let last = body
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          const c = msgs[i].content
          last = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : ''
          break
        }
      }
    } catch {}
    roundNo++
    // 工具轮（审阅批4 探针补场景：工具帧 + /output 查看器打开——P0-2 曾藏在此未测组合）。
    // 工具选 glob（readonly 真跑扫 src——输出大页触发 4KB 截断+viewer 打开）
    // 工具轮第二轮（tool_result 回喂后的收尾文本——判定依据同 wedge-probe：最后一条 user 消息含 tool_result 时收尾）
    const msgs2 = (() => { try { return JSON.parse(body).messages ?? [] } catch { return [] } })()
    const lastMsg = msgs2[msgs2.length - 1]
    const isToolResultTurn = lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.some((b) => b.type === 'tool_result')
    console.log('# [mock] branch=toolResult=' + isToolResultTurn + ' lastRole=' + (lastMsg?.role ?? ''))
    if (isToolResultTurn) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `TOOLDONE-R${roundNo}` } })
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }

    console.log('# [mock] branch=toolround')
    if (last.includes('toolround')) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `toolround-${roundNo} starting` } })
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
      sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${roundNo}`, name: 'glob', input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pattern":"*.ts","path":"src"}' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
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
    const answered = new Set()
    const id = setInterval(() => {
      const tail = strip(out.slice(mark))
      // 活动流 R5：quality/lint 探测的 bash 审批卡会卡轮（探针无人工应答）——自动放行
      const approval = tail.match(/执行 (bash|edit_file|write_file)\?/)
      if (approval !== null && !answered.has(approval[1])) {
        answered.add(approval[1])
        proc.write('y')
      }
      if (re.test(tail)) { clearInterval(id); resolve(true) }
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
      // R5：轮到达 = 末尾标记上屏，或退化/折叠态明示（18 行窗 budget=16<21 按设计 degraded——
      // V5 退化线 21 后 O1 场景不再全文上屏，判定纳入分级形态；3J 检测不受影响）
      const done = await waitFor(
        m,
        new RegExp(`END-OF-R${roundNo + 1}|终端过小|已折叠`),
        30_000,
      )
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

  // O4（审阅批4）：工具轮 + /output 查看器打开——P0-2 曾藏在此未测组合
  // O4（审阅批4）：/output 面板开合——P0-2 曾藏在此未测组合（工具轮 mock 的 SSE 翻译
  // 未通——loop 报「要求工具调用但未给出工具」；真工具帧场景归真机门 G1/楔死四场景，此处
  // 先覆盖面板高度路径：列表页+空态+Esc 关闭全程无 3J）
  const toolPhase = async () => {
    proc.write('\x7f') // 清 O1 回显探针残留的 z（wedge-probe 同款）
    await new Promise((r) => setTimeout(r, 200))
    const m = markNow()
    proc.write('') // 活动流 D14：/output 已退役，Ctrl+T 进执行时间线
    await new Promise((r) => setTimeout(r, 250))
    proc.write('\r')
    // R5：Ctrl+T 直达执行时间线视图（F-50）——断言面板内容特征（时间线工具行/标题）
    const listed = await waitFor(m, /执行时间线|时间线（全部流程）|⌕ |▢ bash|● read_file/, 8000)
    console.log(listed ? 'OK  O4 Ctrl+T 面板打开（执行时间线）' : 'FAIL O4 Ctrl+T 面板未开')
    if (!listed) { ok = false; console.log(dumpTail()); return }
    await new Promise((r) => setTimeout(r, 500))
    proc.write('\x1b')
    await new Promise((r) => setTimeout(r, 500))
    const mEcho = markNow()
    proc.write('z')
    const echoed = await waitFor(mEcho, /z/, 4000)
    console.log(echoed ? 'OK  O4 面板关闭后调度活' : 'FAIL O4 面板关闭后调度死')
    if (!echoed) ok = false
    if (out.includes('[3J')) { console.log('FAIL O4 出现 ESC[3J'); ok = false }
    else console.log('OK  O4 面板开合全程无 ESC[3J')
    proc.write('\x7f') // 清本段 z 回显残留（O3 输入前置干净）
  }
  await phase('O1 小窗 rows=18', 3)
  proc.resize(100, 40)
  await new Promise((r) => setTimeout(r, 800))
  await phase('O3 正常 rows=40', 3)
  await toolPhase()
  if (exited) { console.log('FAIL 子进程意外退出'); ok = false }

  proc.kill()
  server.close()
  if (ok) { console.log('== 全过：超屏防护硬指标达成（全程无 ESC[3J）=='); process.exit(0) }
  console.log('== 存在失败项 ==')
  process.exit(2)
}

run()
