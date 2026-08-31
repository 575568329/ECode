/**
 * D1 回归探针（2026-08-31 走查 + 四角色审阅补钉）：单次模式（print 形态）审批双路径。
 * 此前缺陷：runOnce 的 stdout 适配器默认可应答订阅 → --yes 快速放行与 ask fail-closed
 * 拒绝双双不可达 → 审批挂起至事件循环清空，进程静默 exit 0（无答案无报错）。
 * 契约测试（tests/host/passive-subscriber.test.ts）钉的是 broker 语义层；本探针钉「调用点
 * 接线」——runOnce 若改回默认订阅，两场景必红（挂死 → 超时杀）。
 * 断言：
 *   A1 --yes：副作用工具被自动放行执行（bash ✓）+ 回答产出 + 进程限时退出
 *   A2 无 --yes：fail-closed 拒绝（bash ✗）喂回模型，仍产出回答 + 进程限时退出
 * 跑法：node scripts/runonce-approval-probe.cjs
 */
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const REPO = path.resolve(__dirname, '..')

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-cwd-'))

const sse = (res, e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
let reqNo = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    reqNo++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    sse(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来运行验证命令：' } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    if (reqNo === 1) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tb', name: 'bash' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo probe-ok-42' }) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
    } else {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'round2-answer-完成' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
    }
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

/** spawn 单次模式子进程，收齐 stdout/exitCode（超时强杀返回 null=挂死形态） */
const runOnce = (args, ms) =>
  new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'src', 'cli', 'index.ts'), ...args], {
      cwd,
      env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const killer = setTimeout(() => { try { child.kill() } catch {} }, ms)
    child.on('exit', (code) => {
      clearTimeout(killer)
      resolve({ out, code })
    })
  })

let port
const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  const checks = []
  const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  // A1 --yes：放行执行
  const a = await runOnce(['--yes', '运行 echo probe-ok-42 并把输出告诉我'], 60000)
  check('A1 --yes 进程限时退出（不挂死）', a.code === 0)
  check('A1 --yes 工具被放行执行（bash ✓）', /bash ✓/.test(a.out))
  check('A1 --yes 回答产出（round2 文本）', a.out.includes('round2-answer-完成'))

  // A2 无 --yes：fail-closed 拒绝喂回模型
  reqNo = 0
  const b = await runOnce(['运行 echo probe-ok-42 并把输出告诉我'], 60000)
  check('A2 ask 进程限时退出（不挂死）', b.code === 0)
  check('A2 ask 工具被拒（bash ✗）', /bash ✗/.test(b.out))
  check('A2 ask 回答产出（round2 文本）', b.out.includes('round2-answer-完成'))

  server.close()
  const pass = checks.every(([, ok]) => ok)
  if (!pass) {
    console.log('---- 现场 A1（末 15 行）----')
    console.log(a.out.trim().split('\n').slice(-15).join('\n'))
    console.log('---- 现场 A2（末 15 行）----')
    console.log(b.out.trim().split('\n').slice(-15).join('\n'))
  }
  console.log(pass ? '# 结论：单次模式审批双路径全过' : '# 结论：存在失败项')
  process.exit(pass ? 0 : 1)
}
run().catch((e) => { console.error(e); server.close(); process.exit(1) })
