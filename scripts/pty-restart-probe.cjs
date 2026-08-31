/**
 * /restart 真机探针 v2（用户报：npm run dev 下 /restart 后新实例渲染正常但无法输入）。
 *
 * v1（F-41）两个盲点：① 用 npx tsx 而非用户 npm run dev 形态；② 新实例回显失败只 WARN
 * 不判失败——当时"通过"是假绿。v2 修正：npm run dev 形态 + 回显死=FAIL exit 2。
 *
 * 根因（2026-08-29 定位）：restartProcess 的 pause() 不取消内核里 pending 的 console
 * ReadFile——输入永远先喂给父进程句柄上那次读并被丢弃，子进程 Ink 输入管线挂载完好
 * （rdb=1/refd=true 诊断实证）却等不到字节。修复=spawn 后 process.stdin.destroy() 丢弃
 * 副本句柄。本探针即该修复的回归哨兵。
 *
 * 判定法（W3 楔死探针同源）：打 'x' 看输入框回显——回显=stdin 链路活；无回显=输入死。
 * 跑法：node scripts/pty-restart-probe.cjs
 */
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

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
    }, 150)
  })
const markNow = () => out.length
const lastFrame = (n = 14) =>
  strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-n).join('\n')

/** 输入回显探针：写 'x' 等 4s 看增量里是否出现（区分 mark 后的新帧） */
const echoProbe = async (label) => {
  const m = markNow()
  proc.write('x')
  const echoed = await waitFor(m, /x/, 4000)
  console.log(`${echoed ? 'OK  输入活' : 'FAIL 输入死'} ${label}`)
  if (!echoed) console.log('---- 现场 ----\n' + lastFrame(16))
  return echoed
}

const run = async () => {
  // R1: npm run dev 形态（与用户一致：cross-env FORCE_COLOR=1 tsx src/cli/index.ts）
  proc = pty.spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    cwd: REPO,
    env: { ...process.env, ECODE_FORCE_EMBEDDED: '1', ANTHROPIC_API_KEY: 'dummy-key-for-pty-test', ECODE_MODEL: 'mock-model', ECODE_RESTART_DESTROY: undefined },
    cols: 110,
    rows: 32,
  })
  proc.onData((d) => (out += d))
  proc.onExit(({ exitCode }) => {
    console.error(`子进程退出 code=${exitCode}\n末尾帧:\n${lastFrame(15)}`)
    process.exit(1)
  })

  {
    const ok = await waitFor(0, /输入消息|Ctrl\+J 换行/, 120_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} R1 npm run dev 启动到输入框`)
    if (!ok) { console.log(lastFrame()); process.exit(1) }
  }
  await new Promise((r) => setTimeout(r, 1500))

  // R2 基线回显
  const alive0 = await echoProbe('R2 restart 前基线输入回显')
  await new Promise((r) => setTimeout(r, 800))

  // R3 /restart：退格清探针字符 → 命令两段回车（斜杠补全面板：首回车=填入，次回车=执行）
  proc.write('\x7f')
  await new Promise((r) => setTimeout(r, 500))
  {
    const m = markNow()
    proc.write('/restart')
    await new Promise((r) => setTimeout(r, 900))
    proc.write('\r')
    await new Promise((r) => setTimeout(r, 700))
    proc.write('\r')
    const ok = await waitFor(m, /正在重启/, 20_000)
    console.log(`${ok ? 'OK ' : 'FAIL'} R3a /restart 提示出现`)
    const respawned = await waitFor(m, /ECode · [^\n]*· 0 tok/, 60_000)
    console.log(`${respawned ? 'OK ' : 'FAIL'} R3b 新实例渲染（restart 点后状态栏再现）`)
    if (!respawned) { console.log(lastFrame(18)); process.exit(1) }
  }

  // R4 新实例输入探针（tsx 冷启动+杀毒扫描可能拖到 10s+——轮询回显 20s 窗）
  let alive1 = false
  for (let i = 0; i < 10 && !alive1; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    alive1 = await echoProbe(`R4 restart 后新实例输入回显（第 ${i + 1} 次尝试）`)
  }

  console.log(`\n# 结论：${alive1 ? '未复现——新实例输入活' : '复现——/restart 后输入死'}（restart 前=${alive0 ? '活' : '死'}）`)
  proc.kill()
  process.exit(alive1 ? 0 : 2)
}

run().catch((e) => {
  console.error('driver error:', e)
  if (proc != null) proc.kill()
  process.exit(1)
})
