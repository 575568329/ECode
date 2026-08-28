/**
 * 批2d 验收探针：Notification hook（第七事件）+ BEL 响铃真机断言。
 *
 * 场景矩阵（config notificationIdleSeconds=3 缩短等待）：
 *   S1  审批卡首次出现 → pty 裸 BEL（\x07，须先剥 OSC 序列——其结束符也是 \x07）
 *   S1b 审批挂起 3s 未应答 → hook 留痕 notify.log 含 "reason":"approval-pending"
 *   S2  轮回复完成空闲 3s → notify.log 含 "reason":"idle"
 *   S2b 继续空闲不再重复（只触发一次）；S2c 新轮完成后重新起表再触发
 *   S3  bellOnApproval:false → 审批卡出现但无新 \x07（独立第二 spawn）
 * mock SSE 轮次判定：最后 user 消息含 tool_result 块=工具已执行完回文本收尾；否则按文本关键词。
 * 跑法：node scripts/pty-notify-probe.cjs
 */
const http = require('node:http')
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const REPO = path.resolve(__dirname, '..')

// —— 临时 HOME（隔离真实 ~/.ecode：config/历史/日志全部落在探针沙箱里）——
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-notify-probe-'))
const tmpHome = path.join(tmpRoot, 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
const notifyLog = path.join(tmpRoot, 'notify.log')
const writeConfig = (bell) => {
  fs.writeFileSync(
    path.join(tmpHome, '.ecode', 'config.json'),
    JSON.stringify({
      notificationIdleSeconds: 3,
      bellOnApproval: bell,
      hooks: [{ event: 'Notification', handler: { kind: 'command', command: `cat >> "${notifyLog.replace(/\\/g, '/')}"` } }],
    }),
  )
}

// —— mock SSE：轮 1 文本 / 轮 2 tool_use(bash 写操作→default 档必弹审批卡) / 轮 2b 收尾文本 ——
const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let roundNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    // 判定最后一条 user 消息：tool_result 块=工具完→收尾；文本=新轮
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
      // 轮 2：tool_use（bash 副作用——default 档触发审批卡）
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${roundNo}`, name: 'bash', input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo probe-ok > ' + (tmpRoot.replace(/\\/g, '/')) + '/toolfile.txt"}' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    } else {
      // 文本轮（每轮唯一回复防 loop-guard 复读指纹）与工具收尾轮
      const reply = hasToolResult ? `写入已完成收尾说明第${roundNo}轮` : `问候回复第${roundNo}轮独有内容`
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (let i = 0; i < 3; i++) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / 3), Math.floor((reply.length * (i + 1)) / 3)) } })
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    }
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

// —— 观察基建（wedge-probe 同款教训：alive 布尔 / mark 差分 / OSC 剥离）——
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
/** 裸 BEL 计数：先剥 OSC（其结束符 \x07 不是铃声），再数残留的 \x07 */
const bellCount = (s) => strip(s).split('\x07').length - 1

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
const notifyLines = () => {
  try {
    // hook 走 cat >> 追加不换行（stdin JSON 无尾换行），按事件定界符切分而非按行
    return fs
      .readFileSync(notifyLog, 'utf8')
      .split('{"event":')
      .slice(1)
      .map((s) => '{"event":' + s)
  } catch {
    return []
  }
}

const spawnTui = async (baseEnv) => {
  out = ''
  alive = false
  expectExit = false
  proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, ...baseEnv },
    cols: 110,
    rows: 32,
  })
  alive = true
  proc.onData((d) => (out += d))
  proc.onExit(() => {
    alive = false
    if (expectExit) return
    console.error(`子进程意外退出\n末尾帧:\n${lastFrame(15)}`)
    process.exit(1)
  })
  const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
  if (!ok) { console.log('FAIL 启动到输入框\n' + lastFrame()); process.exit(1) }
}

/** 发消息并等回复片段（写完文本停 600ms 再 CR——与真人节奏一致） */
const round = async (label, text, expect) => {
  const m = markNow()
  proc.write(text)
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  const ok = await waitFor(m, expect, 30_000)
  console.log(`${ok ? 'OK ' : 'FAIL'} ${label}`)
  if (!ok) { console.log(lastFrame(16)); process.exit(1) }
  await new Promise((r) => setTimeout(r, 1200))
}

const fail = (label, detail) => {
  console.log(`FAIL ${label}${detail ? '：' + detail : ''}`)
  console.log('---- 末 16 帧 ----\n' + lastFrame(16))
  console.log('---- notify.log ----\n' + notifyLines().join('\n'))
  if (alive && proc != null) proc.kill()
  expectExit = true
  process.exit(1)
}

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  console.log(`# mock SSE: 127.0.0.1:${port}  tmp=${tmpRoot}`)
  const baseEnv = {
    ECODE_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
    ECODE_MODEL: 'mock-model',
    USERPROFILE: tmpHome, // 隔离 HOME：config/历史/日志全落探针沙箱
  }

  // ===== 会话一：BEL 开 + hook 留痕 =====
  writeConfig(true)
  await spawnTui(baseEnv)
  await round('R1 文本轮', '打个招呼', /问候回复第1轮/)

  // S2 idle 触发：轮完成空闲 3s → hook 留痕
  await new Promise((r) => setTimeout(r, 4500))
  let lines = notifyLines()
  if (!lines.some((l) => l.includes('"reason":"idle"'))) fail('S2 idle 触发留痕', `notify.log ${lines.length} 行无 idle`)
  console.log('OK  S2 idle 触发留痕')

  // S2b 只触发一次：再等 4s 不增
  await new Promise((r) => setTimeout(r, 4000))
  lines = notifyLines()
  const idleCount = lines.filter((l) => l.includes('"reason":"idle"')).length
  if (idleCount !== 1) fail('S2b idle 只触发一次', `idle 计数=${idleCount}`)
  console.log('OK  S2b idle 只触发一次')

  // R2 触发审批卡（bash 写操作，default 档）
  const m2 = markNow()
  proc.write('帮我写入文件')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  const cardUp = await waitFor(m2, /\[y\] 执行/, 30_000)
  if (!cardUp) fail('R2 审批卡弹出', '未出现 [y] 执行 卡面')
  console.log('OK  R2 审批卡弹出')

  // S1 BEL：卡首次出现 → 裸 \x07 ≥1
  const bells = bellCount(out.slice(m2))
  if (bells < 1) fail('S1 审批卡 BEL 响铃', `新增裸 \\x07=${bells}`)
  console.log(`OK  S1 审批卡 BEL 响铃（裸 \\x07=${bells}）`)

  // S1b 挂起 3s 未应答 → approval-pending 留痕
  await new Promise((r) => setTimeout(r, 4500))
  lines = notifyLines()
  if (!lines.some((l) => l.includes('"reason":"approval-pending"'))) fail('S1b 挂起通知留痕', `notify.log 无 approval-pending`)
  console.log('OK  S1b 审批挂起 approval-pending 留痕')

  // 批准 → 工具执行 → 轮 2b 收尾
  const m2b = markNow()
  proc.write('\r')
  const done = await waitFor(m2b, /写入已完成收尾说明/, 30_000)
  if (!done) fail('R2b 批准后收尾', '未见收尾文本')
  if (!fs.existsSync(path.join(tmpRoot, 'toolfile.txt'))) fail('R2b 工具真执行', 'toolfile.txt 未生成')
  console.log('OK  R2b 批准→工具执行→收尾')

  // S2c 新轮完成重新起表 → 第二次 idle
  await new Promise((r) => setTimeout(r, 4500))
  lines = notifyLines()
  const idleCount2 = lines.filter((l) => l.includes('"reason":"idle"')).length
  if (idleCount2 !== 2) fail('S2c 新轮 idle 重新起表', `idle 计数=${idleCount2}（期望 2）`)
  console.log('OK  S2c 新轮完成 idle 重新起表')

  // ===== 会话二：BEL 关 =====
  proc.kill()
  expectExit = true
  await new Promise((r) => setTimeout(r, 1500))
  writeConfig(false)
  await spawnTui(baseEnv)
  const m3 = markNow()
  proc.write('帮我写入文件')
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  const cardUp2 = await waitFor(m3, /\[y\] 执行/, 30_000)
  if (!cardUp2) fail('S3 审批卡弹出', '未出现卡面')
  const bells2 = bellCount(out.slice(m3))
  if (bells2 !== 0) fail('S3 BEL 关闭不响', `裸 \\x07=${bells2}`)
  console.log('OK  S3 bellOnApproval:false 审批卡无 BEL')
  proc.write('\r') // 收尾批准
  await new Promise((r) => setTimeout(r, 1500))
  proc.kill()

  console.log(`\n# 结论：S1/S1b/S2/S2b/S2c/S3 六项全过——Notification hook 与 BEL 真机验收通过`)
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
