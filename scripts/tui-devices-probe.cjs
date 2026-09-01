/**
 * /devices TUI 冒烟探针：真 pty 起 TUI（embedded），提交 /devices，断言设备列表渲染。
 * （协议层测试在 tests/server/devices.test.ts——本探针锁 TUI 本地执行链路。）
 * 用法：node scripts/tui-devices-probe.cjs（退出码 0=过）
 */
const pty = require('node-pty')

const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts', '--local'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: __dirname + '/..',
  env: { ...process.env, ECODE_FORCE_EMBEDDED: '1' },
})
let out = ''
proc.onData((d) => (out += d))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(re, timeout) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (re.test(strip(out))) return true
    await sleep(150)
  }
  return false
}
;(async () => {
  await waitUntil(/输入你的问题|~/, 25000)
  await sleep(500)
  proc.write('/devices')
  await sleep(300)
  proc.write('\r') // 分开写——合并发送会被 conpty 当粘贴内嵌不提交（F 系踩坑）
  await sleep(400)
  proc.write('\r') // 两段式：第一段回车只回填 /devices（补全留参数位）——第二段才提交
  // 断言执行输出（列表标题「配对设备（N）」）而非补全菜单的描述行
  let ok = await waitUntil(/配对设备（\d+）|尚无配对设备/, 15000)
  if (!ok) {
    // 兜底诊断：embedded 模式下命令走 InputStream 本地执行——回显失败时打出尾部帧
    console.error('[DBG tail]', JSON.stringify(strip(out).slice(-400)))
    ok = await waitUntil(/配对设备（\d+）|尚无配对设备/, 8000)
  }
  console.log(ok ? '✓ TUI /devices 输出可见' : '✗ 未见 /devices 输出')
  if (ok) {
    const m = strip(out).match(/配对设备（\d+）[^\n]*/)
    if (m) console.log('  ' + m[0].slice(0, 160))
  }
  proc.write('\x03')
  await sleep(300)
  proc.write('\x03')
  await sleep(800)
  proc.kill()
  process.exit(ok ? 0 : 1)
})()
