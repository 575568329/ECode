const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * D2 回归探针（2026-08-31 走查）：空闲态双击 Esc（<500ms）直达 /rewind 面板。
 * 此前回归根因：TuiApp 消费 @ 下拉端口时写 `port !== null`（端口挂载期注册永非 null）
 * → escGuarded 恒真 → 双击 Esc 永久失效。本探针锁三件事：
 *   E1 单击 Esc 不开面板
 *   E2 双击 Esc（120ms 间隔）开面板（指纹=面板标题「回退到哪个改动之前」）
 *   E3 草稿非空时双击不误开（守卫生效），清空后恢复
 *   E4 Esc 关面板
 * 跑法：node scripts/pty-doublesc-probe.cjs
 */
const http = require('node:http')
const pty = require('node-pty')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const REPO = path.resolve(__dirname, '..')

// 会话隔离到临时 home（不污染真实 ~/.ecode）
const tmpHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-probe-home-')), 'home')
fs.mkdirSync(path.join(tmpHome, '.ecode'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, '.ecode', 'config.json'), JSON.stringify({}))

// 空转 SSE 服务（本探针零 LLM 轮，仅占位端点）
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end()
})

const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0AB]/g, '')
let out = ''
let mark = 0
const waitFor = (re, from, ms) => new Promise((r) => { const t0 = Date.now(); const id = setInterval(() => { if (re.test(strip(out.slice(from ?? 0)))) { clearInterval(id); r(true) } else if (Date.now() - t0 > ms) { clearInterval(id); r(false) } }, 120) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 双击：两发独立 ESC，间隔 120ms（conpty 分块送达=两次独立 Escape 键事件） */
const doubleEsc = () => { proc.write('\x1b'); setTimeout(() => proc.write('\x1b'), 120) }

let proc
const run = async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', USERPROFILE: tmpHome, HOME: tmpHome, ECODE_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'dummy', ECODE_MODEL: 'mock-model' },
    cols: 110, rows: 40,
  })
  proc.onData((d) => (out += d))
  const checks = []
  const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  await waitFor(/ECode/, 0, 20000)
  await sleep(1500)

  // E1 单击 Esc：不开面板
  mark = out.length
  proc.write('\x1b')
  await sleep(1200)
  check('E1 单击 Esc 不开面板', !/回退到哪个改动之前/.test(strip(out.slice(mark))))

  // E2 双击 Esc（120ms）：开面板
  mark = out.length
  doubleEsc()
  const opened = await waitFor(/回退到哪个改动之前/, mark, 4000)
  check('E2 双击 Esc 开 /rewind 面板', opened)

  // E4 Esc 关面板
  mark = out.length
  proc.write('\x1b')
  await sleep(1000)
  check('E4 Esc 关面板', !/回退到哪个改动之前/.test(strip(out.slice(mark))))

  // E3 草稿非空守卫：输入文本后双击不误开 rewind——输入体验批后语义=armed 清空草稿
  mark = out.length
  proc.write('草稿占位')
  await sleep(400)
  doubleEsc()
  await sleep(1500)
  check('E3 草稿非空双击=清空且不开 rewind', !/回退到哪个改动之前/.test(strip(out.slice(mark))) && await waitFor(/输入消息，\/help 查看命令/, mark, 2000))

  // 清草稿（手打草稿非回填态，Esc 不清——用间隔退格逐字清）后双击恢复可用
  for (let i = 0; i < 8; i++) { proc.write('\x7f'); await sleep(120) }
  await sleep(400)
  mark = out.length
  doubleEsc()
  const reopened = await waitFor(/回退到哪个改动之前/, mark, 4000)
  check('E5 清草稿后双击恢复', reopened)

  // E6 @ 下拉守卫分支（D2 回归肇因端口的另一半：read()===true 时不得误开）
  proc.write('\x1b') // 关 E5 面板
  await sleep(1000)
  mark = out.length
  proc.write('@') // 行首 @ → 路径下拉打开
  await waitFor(/Tab\/回车 补全/, mark, 4000)
  doubleEsc()
  await sleep(1500)
  check('E6 @ 下拉开着双击不误开', !/回退到哪个改动之前/.test(strip(out.slice(mark))))
  proc.write('\x1b') // 关下拉
  await sleep(600)
  proc.write('\x7f') // 关不清已输入的 @（草稿仍非空，守卫应拦）——退格清掉
  await sleep(500)
  mark = out.length
  doubleEsc()
  check('E7 关下拉清字符后双击恢复', await waitFor(/回退到哪个改动之前/, mark, 4000))

  killPty(proc)
  server.close()
  const pass = checks.every(([, ok]) => ok)
  if (!pass) {
    console.log('---- 屏幕现场（strip 末 30 行）----')
    console.log(strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-30).join('\n'))
  }
  console.log(pass ? '# 结论：双击 Esc 全过' : '# 结论：存在失败项')
  process.exit(pass ? 0 : 1)
}
run().catch((e) => { console.error(e); try { killPty(proc) } catch {} server.close(); process.exit(1) })
