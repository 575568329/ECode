/**
 * pty-devices-stop-probe：从 TUI /devices 面板停止后台 serve 的真机 E2E（隔离环境）。
 *  D1 隔离 home 冷启动 TUI → 自动拉起 daemon 并附着
 *  D2 /devices 面板显示 本机服务地址 + 访问令牌
 *  D3 停止 serve 二次确认 → 「后台 serve 已停止」+ 本地模式
 *  D4 daemon 确认死亡（health 连不上）
 *  D5 本地模式续聊可用（mock LLM 回复可达）
 *  D6 防自愈：8s+ 后 daemon 不复活（熔断 G3）
 * 用法：node scripts/pty-devices-stop-probe.cjs
 */
const pty = require('node-pty')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9AB]/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`)
}

async function main() {
  // mock LLM（本地模式续聊用）
  let reqCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      reqCount++
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const sse = (e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
      sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `local-ok-${reqCount}` } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      sse('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // 隔离 home + 项目 cwd
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-stopprobe-'))
  fs.mkdirSync(path.join(home, '.ecode'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.ecode', 'config.json'),
    JSON.stringify({
      providers: { m: { type: 'anthropic', baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', models: ['mock-model'] } },
      current: { name: 'm', model: 'mock-model' },
      maxIterations: 5,
    }),
  )
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-stopprobe-cwd-'))

  const proc = pty.spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'src', 'cli', 'index.ts')], {
    cwd,
    env: { ...process.env, USERPROFILE: home, HOME: home, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110,
    rows: 40,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const waitUntil = async (re, since, timeout = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (re.test(strip(out.slice(since ?? 0)))) return true
      await sleep(150)
    }
    return false
  }

  // D1 冷启动：自动拉起 daemon 并附着
  check('D1 TUI 启动', await waitUntil(/输入消息/, 0, 60000))
  const regPath = path.join(home, '.ecode', 'server.json')
  let reg = null
  for (let i = 0; i < 20; i++) {
    try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); break } catch { await sleep(300) }
  }
  check('D1b daemon 注册（自动拉起）', reg !== null && typeof reg.port === 'number', reg ? `port=${reg.port}` : '无 server.json')

  // D2 /devices 面板显示服务地址+token（两段式回车）
  const mark = out.length
  proc.write('/devices')
  await sleep(400)
  proc.write('\r')
  await sleep(300)
  proc.write('\r')
  const addrRe = new RegExp('本机服务\\s+http://127\\.0\\.0\\.1:' + reg.port)
  const addrOk = await waitUntil(addrRe, mark, 15000)
  const tokenOk = await waitUntil(/访问令牌\s+[0-9a-f]{8}/, mark, 5000)
  check('D2 面板显示服务地址+令牌', addrOk && tokenOk, `addr=${addrOk} token=${tokenOk}`)

  // D3 停止 serve：光标默认在停止行（首 item）——回车武装→再回车确认
  const mark3 = out.length
  proc.write('\r')
  await sleep(300)
  proc.write('\r')
  const stopped = await waitUntil(/后台 serve 已停止/, mark3, 20000)
  const localMode = await waitUntil(/本地模式/, mark3, 5000)
  check('D3 停止 serve（确认+提示+本地模式）', stopped && localMode, `stopped=${stopped} local=${localMode}`)

  // D4 daemon 死亡（health 连不上）
  await sleep(1500)
  let dead = false
  try {
    await fetch(`http://127.0.0.1:${reg.port}/api/health`, { signal: AbortSignal.timeout(1500) })
  } catch {
    dead = true
  }
  check('D4 daemon 确认死亡', dead)

  // D5 本地模式续聊可用
  const mark5 = out.length
  proc.write('停止后本地问一句')
  await sleep(300)
  proc.write('\r')
  const localReply = await waitUntil(/local-ok-/, mark5, 30000)
  check('D5 本地模式续聊可用（mock 回复可达）', localReply)

  // D6 防自愈：8s+ 后 daemon 不复活
  await sleep(9000)
  let revived = false
  try {
    await fetch(`http://127.0.0.1:${reg.port}/api/health`, { signal: AbortSignal.timeout(1000) })
    revived = true
  } catch {
    revived = false
  }
  check('D6 防自愈（9s 后不复活）', !revived, revived ? 'daemon 复活了——熔断失效' : '')

  proc.kill()
  server.close()
  try { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }) } catch {}

  const failed = results.filter((x) => !x.ok)
  console.log(`\n# 结论：${results.length - failed.length}/${results.length} 过${failed.length > 0 ? '，失败：' + failed.map((f) => f.name).join(' / ') : ''}`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('driver error:', e)
  process.exit(1)
})
