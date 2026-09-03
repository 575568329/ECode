const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * /devices TUI 冒烟探针（面板形态）：真 pty 起 TUI（embedded）→ /devices 开面板 →
 * 回车「配对新设备」→ 断言终端二维码渲染 + 深链 → Esc 返回 → Esc 关面板。
 * 协议层测试在 tests/server/{devices,pairing}.test.ts——本探针锁 TUI 面板链路。
 * 用法：node scripts/tui-devices-probe.cjs（退出码 0=过；探针生成的配对设备自动吊销）
 */
const pty = require('node-pty')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = os.homedir()
const serverJson = JSON.parse(fs.readFileSync(path.join(home, '.ecode', 'server.json'), 'utf8'))

const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts', '--local'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 40,
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

/** 探针结束后清理本探针生成的配对设备（名字前缀 手机- 且经 daemon 吊销） */
async function cleanupProbeDevices() {
  try {
    const res = await fetch(`http://127.0.0.1:${serverJson.port}/api/devices`, {
      headers: { authorization: `Bearer ${serverJson.token}` },
      signal: AbortSignal.timeout(3000),
    })
    const r = await res.json()
    for (const d of r.devices ?? []) {
      if (!d.name.startsWith('手机-')) continue
      await fetch(`http://127.0.0.1:${serverJson.port}/api/devices/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${serverJson.token}` },
        body: JSON.stringify({ deviceId: d.deviceId }),
        signal: AbortSignal.timeout(3000),
      })
      console.log(`  [cleanup] 已吊销探针设备 ${d.deviceId}(${d.name})`)
    }
  } catch {
    /* 清理失败不掩盖主断言 */
  }
}

;(async () => {
  await waitUntil(/输入你的问题|~/, 25000)
  await sleep(500)
  proc.write('/devices')
  await sleep(300)
  proc.write('\r') // 两段式：第一段回车只回填（补全留参数位）
  await sleep(300)
  proc.write('\r') // 第二段提交 → 面板打开
  const panelOpen = await waitUntil(/配对新设备/, 10000)
  if (!panelOpen) {
    console.error('✗ 面板未打开')
    console.error('[DBG tail]', JSON.stringify(strip(out).slice(-300)))
    killPty(proc)
    await cleanupProbeDevices()
    process.exit(1)
  }
  console.log('✓ /devices 面板打开（列表+配对入口）')
  await sleep(300)
  proc.write('\r') // 光标初始在「配对新设备」——回车生成
  const qrOk = await waitUntil(/链接：https:\/\/|配对已生成/, 15000)
  const qrBlocks = /[▀▄█]{4,}/.test(strip(out))
  console.log(qrOk ? '✓ 配对已生成（深链可见）' : '✗ 未见配对结果')
  if (!qrBlocks) {
    fs.writeFileSync(path.join(__dirname, 'tui-devices-dbg.txt'), strip(out).slice(-3000), 'utf8')
    console.log('  [DBG] 尾部帧已落 scripts/tui-devices-dbg.txt')
  }
  console.log(qrBlocks ? '✓ 终端二维码已渲染（块字符）' : '✗ 未见二维码块字符')
  await sleep(300)
  proc.write('\x1b') // 任意键：返回列表
  await sleep(200)
  proc.write('\x1b') // Esc：关面板
  await sleep(400)
  proc.write('\x03')
  await sleep(300)
  proc.write('\x03')
  await sleep(800)
  try {
    killPty(proc)
  } catch {
    /* conpty 收尾竞态（AttachConsole）——断言已完成，不掩盖结果 */
  }
  await cleanupProbeDevices()
  process.exit(qrOk && qrBlocks ? 0 : 1)
})()
