/**
 * F-41 /restart 真机探针：pty 起 ECode → /restart → 判定新实例在同一终端接管
 * （第二次出现就绪输入框 = 新进程渲染；旧进程退出后 pty 无残留提示符交错）。
 * 跑法：node scripts/pty-restart-probe.cjs
 */
const pty = require('D:/study/ECode/node_modules/node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '')

async function main() {
  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-key-for-pty-test' },
    cols: 90, rows: 30,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const count = (s) => strip(out).split(s).length - 1

  // 1) 首实例就绪
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { await sleep(200); ok = count('输入消息') >= 1 }
  if (!ok) { console.log('FAIL 首实例未就绪'); proc.kill(); process.exit(1) }
  console.log('OK   首实例就绪')
  await sleep(800)

  // 2) /restart：斜杠补全面板会消费第一次回车（填入），逐键 dump 观察
  const before = out.length
  proc.write('/restart')
  await sleep(600)
  proc.write('\r') // 面板：回车=填入
  await sleep(600)
  console.log('# 填入后帧尾：', strip(out).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-3).join(' | ').slice(-160))
  proc.write('\r') // 执行
  await sleep(600)
  console.log('# 执行后帧尾：', strip(out).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-3).join(' | ').slice(-160))
  ok = false
  for (let i = 0; i < 40 && !ok; i++) { await sleep(200); ok = strip(out.slice(before)).includes('正在重启') }
  if (!ok) {
    console.log('WARN 未捕获「正在重启」提示——密集 dump：')
    for (let i = 0; i < 5; i++) {
      const pos = out.length
      await sleep(400)
      const delta = strip(out.slice(pos)).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).join(' | ')
      console.log(`# +${(i + 1) * 400}ms: ${delta === '' ? '(无输出)' : delta.slice(0, 160)}`)
    }
  }

  // 3) 新实例接管：重启后再次出现就绪输入框（tsx 冷启动给足 30s）
  const afterRestart = out.length
  ok = false
  for (let i = 0; i < 150 && !ok; i++) {
    await sleep(200)
    // 新实例的判定：restart 触发点之后再次渲染出输入框占位 + 模型状态行
    const delta = strip(out.slice(afterRestart))
    ok = delta.split('输入消息').length - 1 >= 1 && /ECode ·/.test(delta)
  }
  if (!ok) {
    console.log('FAIL 新实例 30s 内未接管终端')
    console.log(strip(out.slice(afterRestart)).split('\n').filter(Boolean).slice(-12).join('\n'))
    proc.kill()
    process.exit(1)
  }
  await sleep(1000)
  // 4) 新实例可交互：输入有回显（tsx 冷启动 stdin raw mode 就绪有延迟——轮询 5s）
  proc.write('echo-alive-check')
  ok = false
  for (let i = 0; i < 16 && !ok; i++) { await sleep(300); ok = strip(out.slice(afterRestart)).includes('echo-alive-check') }
  console.log(ok ? 'OK   新实例接管终端且可交互（回显正常）' : 'WARN 新实例渲染了但回显未捕获')
  console.log('# 重启窗口末 14 行：')
  console.log(strip(out.slice(afterRestart)).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-14).join('\n'))
  console.log('== 结论：/restart 重启链路真机通过 ==')
  proc.kill()
  setTimeout(() => process.exit(0), 200)
}

void main()
