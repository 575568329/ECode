const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * 输入体验批探针（2026-08-31）：双击 Esc 清空草稿（armed 确认式）+ 输入框查看窗。
 * 断言（strip 后流内指纹，禁用常驻 UI 文本作判定）：
 *   C1 草稿非空：第一次 Esc 出现待清提示行（「再按 Esc 清空输入」），第二次 Esc 清空草稿
 *      （占位符回归）且不开 rewind 面板
 *   C2 第一次 Esc 后按其他键 → 不清空（草稿保留编辑结果）
 *   C3 空草稿双击 Esc → rewind 面板（现状回归）
 *   C4 12 行粘贴 → 头窗 + caret 行；PgDn → 查看窗下移（新行指纹出现）
 * 跑法：node scripts/pty-input-clear-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const REPO = path.resolve(__dirname, '..')

const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))

// 空转 SSE（本探针零 LLM 轮）
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end()
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
let out = ''
let mark = 0
const waitFor = (re, from, ms) => new Promise((r) => { const t0 = Date.now(); const id = setInterval(() => { if (re.test(strip(out.slice(from ?? 0)))) { clearInterval(id); r(true) } else if (Date.now() - t0 > ms) { clearInterval(id); r(false) } }, 120) })
const absentIn = (re, from) => !re.test(strip(out.slice(from)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const doubleEsc = () => { proc.write('\x1b'); setTimeout(() => proc.write('\x1b'), 120) }

let proc
const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  proc = pty.spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'src', 'cli', 'index.ts')], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 40,
  })
  proc.onData((d) => (out += d))
  const checks = []
  const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  await waitFor(/ECode/, 0, 20000)
  await sleep(1500)

  // C3（先跑，趁草稿为空）：空草稿双击 Esc → rewind 面板
  mark = out.length
  doubleEsc()
  check('C3 空草稿双击 Esc 开 rewind（现状回归）', await waitFor(/回退到哪个改动之前/, mark, 4000))
  proc.write('\x1b') // 关面板
  await sleep(1000)

  // C1：草稿非空 → armed 提示 → 第二次 Esc 清空
  proc.write('hello-clear-test')
  await sleep(800)
  mark = out.length
  proc.write('\x1b')
  check('C1a 第一次 Esc 出待清提示', await waitFor(/再按 Esc 清空输入/, mark, 3000))
  await sleep(300)
  mark = out.length
  proc.write('\x1b')
  await sleep(1500)
  check('C1b 第二次 Esc 清空草稿（占位符回归）', await waitFor(/输入消息，\/help 查看命令/, mark, 3000))
  check('C1c 清空不开 rewind', absentIn(/回退到哪个改动之前/, mark))

  // C2：第一次 Esc 后按其他键 → 不清空
  proc.write('keepme')
  await sleep(800)
  proc.write('\x1b')
  await sleep(400)
  proc.write('x')
  await sleep(1000)
  mark = out.length
  check('C2a 其他键解除待清且不清空', absentIn(/输入消息，\/help 查看命令/, mark))
  check('C2b 草稿保留编辑结果（keepmex）', /keepmex/.test(strip(out.slice(mark - 4000))))

  // C5 armed 超时（审阅 2a）：arm 后 1.7s 超时（>1.5s 窗）→ Esc 重新 arm 不得清空
  proc.write('\x1b')
  await sleep(1700)
  mark = out.length
  proc.write('\x1b')
  check('C5a 超时后 Esc 重新 arm（提示再现，草稿未清）', await waitFor(/再按 Esc 清空输入/, mark, 3000))
  await sleep(300)
  mark = out.length
  proc.write('\x1b')
  await sleep(1500)
  check('C5b 窗内第二次 Esc 清空', await waitFor(/输入消息，\/help 查看命令/, mark, 3000))


  // C4（输入体验批二期）：12 行粘贴 → token 化显示 `[粘贴#1 +11 行]`，原文不进输入框
  const lines = Array.from({ length: 12 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
  mark = out.length
  proc.write(lines.join('\r')) // \r 进 TextInput 归一为 \n（终端粘贴同路径）
  await sleep(1500)
  check('C4a 大粘贴出 token（粘贴#1 +11 行）', await waitFor(/粘贴#1 \+11 行/, mark, 4000))
  check('C4b 原文不进输入框（L06 缺席）', absentIn(/L06/, mark))
  proc.write('\x1b[6~') // PgDn：折叠已退役，应无任何折叠/查看窗反应
  await sleep(800)
  check('C4c PgDn 不再产生折叠指示', absentIn(/已折叠/, mark))

  killPty(proc)
  server.close()
  const pass = checks.every(([, ok]) => ok)
  if (!pass) {
    console.log('---- 屏幕现场（strip 末 35 行）----')
    console.log(strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-35).join('\n'))
  }
  console.log(pass ? '# 结论：输入体验批探针全过' : '# 结论：存在失败项')
  process.exit(pass ? 0 : 1)
}
run().catch((e) => { console.error(e); try { killPty(proc) } catch {} server.close(); process.exit(1) })
