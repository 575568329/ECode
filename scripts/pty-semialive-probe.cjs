const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
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
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      toolPhase = false
    } else if (toolPhase) {
      // 工具轮：发 tool_use（工具由客户端真实执行；ls 是 readonly 免审批工具）
      // 协议保真（角色D）：input 走 input_json_delta 传输（空对象），stop_reason 用 tool_use——
      // 消除对 loop stop-lying 防御与 __parse_error 容错的隐性依赖
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_semialive', name: 'ls', input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    } else {
      // 普通文本轮（每轮唯一回复——loop-guard 复读指纹安全网别被触发）
      // content_block_start 不能省：provider 按 index 建 block，缺 start 时 delta 落在未建 block 上
      // （实测报 Cannot read properties of undefined (reading 'type')，重试 3 次熔断）
      const reply = `半活探针第${roundNo}轮唯一回复`
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (let i = 0; i < 3; i++) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(Math.floor((reply.length * i) / 3), Math.floor((reply.length * (i + 1)) / 3)) } })
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    }
    // 工具轮首段的 stop_reason 必须是 tool_use（协议语义；文本收尾轮与普通轮 end_turn）
    const stopReason = toolPhase && !sawToolResult ? 'tool_use' : 'end_turn'
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

// ---------- pty 驱动 ----------
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')

let out = ''
let proc = null
let alive = false // respawn 判定权威源（onExit 置 false；exitCode/pid 均不可靠）
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

/** 探针1 前置：回显层探针（批2a 六修 #6）——`zz` 写入后断言回显出现。
 *  区分「调度死」（连回显都没有，wedge 探针的领域）vs「半活」（回显活但功能键死）。
 *  回显失败时 Enter 探针的 FAIL 不可归因于键路由，须单独记录。 */
const echoProbe = async (label) => {
  const m = markNow()
  proc.write('zz')
  const ok = await waitFor(m, /zz/, 3000)
  if (!ok) console.log(`FAIL 回显死（调度层楔死，非半活） ${label}`)
  else console.log(`OK  回显活 ${label}`)
  // 清掉 zz——残留会让后续 /stats 变 zz/stats 走普通消息提交，Enter 探针全数假 FAIL
  // （批2a 首版实证的探针自伤；wedge 探针 echoProbe 同款退格清理）
  if (ok) {
    // 逐个退格+间隔：连续两发 \x7f 第二个会被吞（实测只删一个 z）——z/stats 假 FAIL 同源
    proc.write('\x7f')
    await new Promise((r) => setTimeout(r, 400))
    proc.write('\x7f')
    await new Promise((r) => setTimeout(r, 400))
  }
  return ok
}

/** 探针1：Enter 提交（/stats 本地聚合零 token）。
 *  批2a 六修：
 *   #1 两段式协议——ECode 斜杠命令首 Enter 只回填（InputStream.tsx:185-195 两段式），
 *      发两次 \r（首按回填、次按执行）；
 *   #2 判定指纹收紧到命令输出独有行（含「暂无数据」空库形态——新机器必假阴），
 *      并 mark 移到 \r 之后（打字阶段渲染的 SlashSuggest 补全列表不再被计入——
 *      旧指纹「跨会话|token|模型」恰是补全描述文案，打字即命中=假阳性三重 bug 之一）。 */
const STATS_FINGERPRINT = /总计：输入|个会话|暂无数据|统计不可用：|运行中暂不能执行命令/
const enterProbe = async (label) => {
  const echoOk = await echoProbe(`${label}·回显`)
  proc.write('/stats')
  await new Promise((r) => setTimeout(r, 500))
  proc.write('\r')
  await new Promise((r) => setTimeout(r, 350)) // 首按回填后补全列表清场
  const m = markNow() // mark 在最后一次 \r 之后：只看 Enter 之后的新帧
  proc.write('\r')
  const ok = await waitFor(m, STATS_FINGERPRINT, 8000)
  // 探针命令的残留输出清不干净没关系（下轮 WaitFor 用唯一指纹）；/stats 不入 LLM 历史
  console.log(`${ok ? 'OK  Enter 生效' : `FAIL Enter 走死队列（${echoOk ? '半活实锤' : '回显亦死，调度层问题'}）`} ${label}`)
  if (!ok) { await evidence(label); failed = true }
  await new Promise((r) => setTimeout(r, 800))
}

/** 探针2：Ctrl+C 双击优雅退出（空闲态）。
 *  批2a 六修：
 *   #3 expectExit 标志——本探针进入即置位，spawnTui 的「意外退出」兜底跳过
 *      （旧版 Ctrl+C 探针成功退出反而触发 spawnTui 的 process.exit(1) 自杀，「全过」不可达）；
 *   #5 判定窗 6s→9s（graceful 预算 5.5s 余量过窄）。 */
const ctrlCProbe = async (label) => {
  expectExit = true // 六修 #3：进入预期退出窗口，spawnTui 兜底静默
  const exited = await new Promise((resolve) => {
    let done = false
    const onExit = () => { done = true; resolve(true) }
    proc.onExit(onExit)
    proc.write('\x03')
    setTimeout(() => proc.write('\x03'), 350)
    setTimeout(() => { if (!done) resolve(false) }, 9000)
  })
  console.log(`${exited ? 'OK  Ctrl+C 优雅退出' : 'FAIL Ctrl+C 键消费死（半活实锤）'} ${label}`)
  if (!exited) {
    await evidence(label)
    killPty(proc)
    failed = true
    // kill 触发的 onExit 是异步事件——此处不复位 expectExit（否则兜底把探针自杀，矩阵中断），
    // 由下一次 spawnTui 开头统一复位
    return exited
  }
  expectExit = false
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
let baseUrl = ''
let settling = false
let expectExit = false // 批2a 六修 #3：ctrlCProbe 预期退出窗口——spawnTui 的「意外退出」兜底须跳过

const spawnTui = () =>
  new Promise((resolve, reject) => {
    // 相位与预期退出标志随新进程复位（角色C/D：mock 侧 toolPhase 若不复位，
    // respawn 后新 TUI 的首个请求会错收 tool_use——相位串台）
    expectExit = false
    toolPhase = false
    roundNo = 0
    // Windows node-pty 直接 spawn 'node' 报 File not found——与 wedge 探针一致统一走 cmd.exe 壳
    proc = pty.spawn('cmd.exe', ['/c', ...TARGET], {
      cwd: REPO,
      env: {
        ...process.env,
        ECODE_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'dummy-key-for-pty-test',
        ECODE_MODEL: 'mock-model',
      ECODE_FORCE_EMBEDDED: '1', // T 线后防自动附着运行中 daemon（轮次跑 daemon 进程=无 mock env → 打真端点）
      },
      cols: 110,
      rows: 32,
    })
    alive = true
    out = ''
    proc.onData((d) => (out += d))
    proc.onExit(({ exitCode }) => {
      alive = false
      if (settling || expectExit) return
      console.error(`子进程意外退出 code=${exitCode}\n末尾帧:\n${lastFrame(15)}`)
      process.exit(1)
    })
    resolve()
  })

/** 场景执行包装（六修 #4：FAIL 不再 fail-fast 丢矩阵——记 failed+证据+respawn 续跑，
 *  结尾统一 exit 汇总；旧版任一 FAIL 即 process.exit(1)，「触发因素=本地命令轮」成倒推推断） */
const runScenario = async (label, fn) => {
  try {
    await fn()
  } catch (e) {
    console.log(`FAIL ${label} 异常：${e && e.message ? e.message : e}`)
    await evidence(label)
    failed = true
    try { killPty(proc) } catch {}
  }
  // ctrlCProbe 已杀/已退 → 下场景前确保干净重生。
  // 判定用 alive 布尔（onExit 置 false）——旧版查 proc.exitCode/pid：node-pty 的 IPty
  // 没有 exitCode 属性且 pid 退出后仍保留，三条件恒 false → respawn 永不触发 →
  // S2/S3 对死进程 write 必假 FAIL（角色C P1-2/角色D P0-1——此前"S2/S3 场景级问题"的真凶）
  if (proc == null || !alive) {
    try { killPty(proc) } catch {}
    await spawnTui()
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 90_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} respawn（${label} 后）`)
    if (!ok) { console.log(lastFrame()); failed = true }
  }
}

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

  // ---- S1 纯文本轮 ×3（每轮末 Enter 探针；完整组含 Ctrl+C 探针）----
  await runScenario('S1', async () => {
    for (let i = 1; i <= 3; i++) {
      const ok = await round(`消息S1-${i}`, new RegExp(`半活探针第\\d+轮唯一回复`))
      console.log(`${ok ? 'OK ' : 'FAIL'} S1 文本轮#${i} 渲染`)
      if (!ok) { console.log(lastFrame(16)); failed = true; return }
      await new Promise((r) => setTimeout(r, 1200))
      await enterProbe(`S1#${i}`)
    }
    await probeGroup('S1 完整组')
  })

  // ---- S2 本地命令轮：/stats → 等输出 → 探针（dogfood 卡死场景）----
  await runScenario('S2', async () => {
    {
      const m = markNow()
      proc.write('/stats')
      await new Promise((r) => setTimeout(r, 500))
      proc.write('\r')
      await new Promise((r) => setTimeout(r, 350))
      const m2 = markNow() // 第二段 \r 之后的帧才算执行证据（同 enterProbe #2 理由）
      proc.write('\r')
      const ok = await waitFor(m2, STATS_FINGERPRINT, 10_000)
      console.log(`${ok ? 'OK ' : 'FAIL'} S2 /stats 本地命令执行`)
      if (!ok) { console.log(lastFrame(16)); failed = true; return }
      await new Promise((r) => setTimeout(r, 1200))
    }
    await probeGroup('S2 完整组')
  })

  // ---- S3 工具轮：tool_use/tool_result 往返（mock 带 tools 定义由客户端真实装配）----
  await runScenario('S3', async () => {
    {
      toolPhase = true
      const ok = await round('工具往返', /工具往返完成/, 45_000)
      console.log(`${ok ? 'OK ' : 'FAIL'} S3 tool_use/tool_result 往返`)
      if (!ok) { console.log(lastFrame(16)); failed = true; return }
      await new Promise((r) => setTimeout(r, 1500))
    }
    await probeGroup('S3 完整组')
  })

  // ---- 结论（六修 #4：结尾统一 exit 汇总——0 全过 / 2 存在 FAIL）----
  settling = true
  try { killPty(proc) } catch {}
  server.close()
  server.closeAllConnections()
  console.log(failed ? '\n# 结论：存在 FAIL —— F-08 未治愈（或探针仍有假信号，按末 20 帧甄别），按机理 A/B 定位实修' : '\n# 结论：S1-S3 全过 —— 半活楔死未复现，F-08 可销案（新版 dist）')
  process.exit(failed ? 2 : 0)
}

run().catch((e) => {
  console.error('driver error:', e)
  settling = true
  if (proc != null) try { killPty(proc) } catch {}
  process.exit(1)
})
