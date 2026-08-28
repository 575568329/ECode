/**
 * 半活楔死专项探针（F-08 复测裁决 · 方案 §3.1）。
 *
 * 缺口：pty-wedge-probe 的调度活性判定 = stdin 回显；半活态下「回显活但功能键死」
 * ——探针全过 ≠ 没楔死。本探针补第二判定组：
 *
 *   1. Enter 提交探针（不烧 token 设计）：轮末写 `/stats` + \r——/stats 是本地聚合
 *      （registry.ts aggregateStats，零 LLM 调用），判定任一预期帧：
 *        a. 统计输出出现（Enter 生效、命令执行）；
 *        b. 忙碌拦截提示出现（InputStream.tsx:152 onSlashBusy 分支——Enter 生效、被分流）。
 *      两者皆无且超时 → 半活实锤（Enter 未被处理）。
 *   2. Ctrl+C 语义探针：空闲态双击 Ctrl+C（9ad1a83 语义：优雅退出），N 秒内进程
 *      应退出；不退 → 键消费死。
 *   3. 场景矩阵（每场景后跑 1+2）：
 *        S1 纯文本轮 ×3（对齐 wedge 探针）；
 *        S2 本地命令轮：发 /stats → 等输出 → 探针（dogfood 卡死场景首次进探针覆盖）；
 *        S3 工具轮：mock SSE 带 tool_use/tool_result 往返（tools 定义必须给出——
 *          挂账坑：loop 要求工具调用但请求未带 tools 会熔断）。
 *   4. 输出：每场景 OK/FAIL 一行；FAIL 时末 20 帧 + CPU 差分留痕（沿用 wedge 探针取证格式）。
 *
 * 跑法：node scripts/pty-semialive-probe.cjs [dist|src]
 *   dist（缺省）= 验证构建产物（复测裁决用这个——dogfood 教训：先核对 dist mtime vs HEAD）
 *   src = npx tsx 源码（对齐旧 wedge 探针跑法）
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const { execSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const TARGET = process.argv[2] === 'src' ? ['npx', 'tsx', 'src/cli/index.ts'] : ['node', 'dist/cli/index.js']

// ---------- mock SSE ----------
const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
let roundNo = 0
let toolPhase = false // S3 工具往返相位（True=下一条请求回 tool_use）
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    // 最后一条 user 消息（判定依据——全 body includes 会被历史污染，wedge 探针踩过）
    let last = ''
    let sawToolResult = false
    try {
      const j = JSON.parse(body)
      const msgs = j.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const c = msgs[i].content
        if (msgs[i].role === 'user' && last === '') {
          last = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : ''
          if (last !== '') break
        }
        if (msgs[i].role === 'user' && Array.isArray(c) && c.some((b) => b.type === 'tool_result')) sawToolResult = true
      }
    } catch {}
    roundNo++
    if (toolPhase && sawToolResult) {
      // 工具结果回程：文本收尾（S3 第二段）
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `工具往返完成（第${roundNo}轮）` } })
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
      toolPhase = false
    } else if (toolPhase) {
      // 工具轮：发 tool_use（输入故意小；工具由客户端真实执行）
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_semialive', name: 'ls', input: {} } })
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
    } else {
      // 普通文本轮（每轮唯一回复——loop-guard 复读指纹安全网别被触发）
      const reply = `半活探针第${roundNo}轮唯一回复`
      for (let i = 0; i < 3; i++) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / 3), Math.floor((reply.length * (i + 1)) / 3)) } })
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop' })
    }
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

// ---------- pty 驱动 ----------
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
const lastFrame = (n = 14) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

/** FAIL 取证：末 20 帧 + CPU 差分（沿用 wedge 探针格式） */
const evidence = async (label) => {
  console.log(`---- ${label} 现场末 20 帧 ----\n${lastFrame(20)}`)
  try {
    const pid = proc.pid
    const c1 = execSync(`powershell -c "(Get-Process -Id ${pid}).CPU"`).toString().trim()
    await new Promise((r) => setTimeout(r, 2000))
    const c2 = execSync(`powershell -c "(Get-Process -Id ${pid}).CPU"`).toString().trim()
    console.log(`# CPU 差分: ${c1} -> ${c2}（不变=静默死锁）`)
  } catch {}
}

let failed = false

/** 探针1：Enter 提交（/stats 本地聚合零 token）。判定统计输出或忙碌拦截任一出现。 */
const enterProbe = async (label) => {
  const m = markNow()
  proc.write('/stats')
  await new Promise((r) => setTimeout(r, 500))
  proc.write('\r')
  const ok = await waitFor(m, /跨会话|token|模型|会话数|运行中暂不能执行命令|忙碌/, 8000)
  // 探针命令的残留输出清不干净没关系（下轮 WaitFor 用唯一指纹）；/stats 不入 LLM 历史
  console.log(`${ok ? 'OK  Enter 生效' : 'FAIL Enter 走死队列（半活实锤）'} ${label}`)
  if (!ok) { await evidence(label); failed = true }
  await new Promise((r) => setTimeout(r, 800))
}

/** 探针2：Ctrl+C 双击优雅退出（空闲态）。判定进程 6s 内退出。 */
const ctrlCProbe = async (label) => {
  const exited = await new Promise((resolve) => {
    let done = false
    const onExit = () => { done = true; resolve(true) }
    proc.onExit(onExit)
    proc.write('\x03')
    setTimeout(() => proc.write('\x03'), 350)
    setTimeout(() => { if (!done) resolve(false) }, 6000)
  })
  console.log(`${exited ? 'OK  Ctrl+C 优雅退出' : 'FAIL Ctrl+C 键消费死（半活实锤）'} ${label}`)
  if (!exited) { await evidence(label); proc.kill(); failed = true }
  return exited
}

/** 发一轮消息并等回复指纹 */
const round = async (text, expect, timeout = 30_000) => {
  const m = markNow()
  proc.write(text)
  await new Promise((r) => setTimeout(r, 600))
  proc.write('\r')
  return waitFor(m, expect, timeout)
}

/** 场景后完整探针组（1+2；探针2 杀进程，跑完须 respawn） */
const probeGroup = async (label) => {
  await enterProbe(`${label}·Enter`)
  await ctrlCProbe(`${label}·Ctrl+C`)
}

/** 起 TUI 子进程 */
const spawnTui = () =>
  new Promise((resolve, reject) => {
    proc = pty.spawn(TARGET[0] === 'node' ? TARGET[0] : 'cmd.exe', TARGET[0] === 'node' ? TARGET.slice(1) : ['/c', ...TARGET], {
      cwd: REPO,
      env: {
        ...process.env,
        ECODE_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
        ECODE_MODEL: 'mock-model',
      },
      cols: 110,
      rows: 32,
    })
    out = ''
    proc.onData((d) => (out += d))
    proc.onExit(({ exitCode }) => {
      if (settling) return
      console.error(`子进程意外退出 code=${exitCode}\n末尾帧:\n${lastFrame(15)}`)
      process.exit(1)
    })
    resolve()
  })

let baseUrl = ''
let settling = false

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`# mock SSE: ${baseUrl}`)
  console.log(`# target: ${TARGET.join(' ')}`)

  // 启动
  await spawnTui()
  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} 启动到输入框`)
    if (!ok) { console.log(lastFrame()); process.exit(1) }
  }

  // ---- S1 纯文本轮 ×3（每轮末 Enter 探针；最后一轮后 Ctrl+C 探针）----
  for (let i = 1; i <= 3; i++) {
    const ok = await round(`消息S1-${i}`, new RegExp(`半活探针第\\d+轮唯一回复`))
    console.log(`${ok ? 'OK ' : 'FAIL'} S1 文本轮#${i} 渲染`)
    if (!ok) { console.log(lastFrame(16)); process.exit(1) }
    await new Promise((r) => setTimeout(r, 1200))
    await enterProbe(`S1#${i}`)
  }
  await probeGroup('S1 完整组')

  // ---- S2 本地命令轮：/stats → 等输出 → 探针（dogfood 卡死场景）----
  await spawnTui()
  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
    if (!ok) { console.log('FAIL S2 启动'); process.exit(1) }
    console.log('OK  S2 启动到输入框')
  }
  {
    const m = markNow()
    proc.write('/stats')
    await new Promise((r) => setTimeout(r, 500))
    proc.write('\r')
    const ok = await waitFor(m, /跨会话|token|模型|会话数|统计不可用/, 10_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} S2 /stats 本地命令执行`)
    if (!ok) { console.log(lastFrame(16)); process.exit(1) }
    await new Promise((r) => setTimeout(r, 1200))
  }
  await probeGroup('S2 完整组')

  // ---- S3 工具轮：tool_use/tool_result 往返（mock 带 tools 定义由客户端真实装配）----
  await spawnTui()
  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
    if (!ok) { console.log('FAIL S3 启动'); process.exit(1) }
    console.log('OK  S3 启动到输入框')
  }
  {
    toolPhase = true
    const ok = await round('工具往返', /工具往返完成/, 45_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} S3 tool_use/tool_result 往返`)
    if (!ok) { console.log(lastFrame(16)); process.exit(1) }
    await new Promise((r) => setTimeout(r, 1500))
  }
  await probeGroup('S3 完整组')

  // ---- 结论 ----
  settling = true
  try { proc.kill() } catch {}
  server.close()
  server.closeAllConnections()
  console.log(failed ? '\n# 结论：存在 FAIL —— F-08 未治愈，按机理 A/B 定位实修' : '\n# 结论：S1-S3 全过 —— 半活楔死未复现，F-08 可销案（新版 dist）')
  process.exit(failed ? 2 : 0)
}

run().catch((e) => {
  console.error('driver error:', e)
  settling = true
  if (proc != null) try { proc.kill() } catch {}
  process.exit(1)
})
