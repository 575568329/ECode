/**
 * 一次性内存探针（2026-08-29 用户问：一个 ECode 终端占多少内存）。
 * 起 mock SSE + pty TUI，等启动稳定后枚举进程树（Windows CIM）量 WorkingSet 分解。
 * 跑法：node scripts/pty-mem-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')

// 审阅 D5：会话/transcript 隔离到临时 home（mock 轮不再污染真实 ~/.ecode）
const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const sse = (res, event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`)
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model: 'mock-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '内存探针回复' } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

/** 枚举全系统进程 → 从 root BFS 出进程树，返回合计与 top 分解 */
function treeRss(rootPid) {
  const csv = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation"`,
  ).toString()
  const procs = []
  for (const m of csv.matchAll(/"([^"]*)","(\d+)","(\d+)","(\d+)"/g)) {
    procs.push({ name: m[1], pid: Number(m[2]), ppid: Number(m[3]), ws: Number(m[4]) })
  }
  const childrenOf = new Map()
  for (const p of procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, [])
    childrenOf.get(p.ppid).push(p)
  }
  const tree = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    const self = procs.find((x) => x.pid === pid)
    if (self !== undefined) tree.push(self)
    for (const c of childrenOf.get(pid) ?? []) {
      if (!seen.has(c.pid)) { seen.add(c.pid); queue.push(c.pid) }
    }
  }
  const total = tree.reduce((a, b) => a + b.ws, 0)
  tree.sort((a, b) => b.ws - a.ws)
  return { totalMB: total / 1024 / 1024, top: tree.slice(0, 8).map((x) => `${x.name}(${x.pid}) ${((x.ws) / 1024 / 1024).toFixed(1)}MB`) }
}

const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  // argv[2] 可覆盖启动命令（默认 npx tsx 开发态；可传 "node dist/cli/index.js" 量打包形态）
  const cmd = process.argv[2] ?? 'npx tsx src/cli/index.ts'
  const parts = cmd.split(' ')
  const [file, args] = parts[0] === 'node'
    ? [process.execPath, parts.slice(1)]
    : ['cmd.exe', ['/c', ...parts]]
  const proc = pty.spawn(file, args, {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy-key-for-pty-test', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 32,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const ready = async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      if (/ECode/.test(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')) && Date.now() - t0 > 8000) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }
  await ready()
  const s1 = treeRss(proc.pid)
  console.log(`[启动稳定后]  进程树合计 ${s1.totalMB.toFixed(1)}MB`)
  console.log('  top: ' + s1.top.join(' | '))
  // 跑一轮 mock 对话再量稳态
  proc.write('你好\r')
  await new Promise((r) => setTimeout(r, 6000))
  const s2 = treeRss(proc.pid)
  console.log(`[一轮对话后]  进程树合计 ${s2.totalMB.toFixed(1)}MB`)
  console.log('  top: ' + s2.top.join(' | '))
  try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }) } catch {}
  server.close()
  process.exit(0)
}
run().catch((e) => { console.error(e); process.exit(1) })
