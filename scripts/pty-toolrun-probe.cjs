const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * 同名工具折叠批真 pty 探针（2026-09-03 用户拍板「相同的工具能折叠也折叠」）：
 *   A toolrun-dyn  cols=100：7 连发 bash（done）动态区 → 「bash ×6 已折叠」摘要 +
 *                  最新 1 条完整（kw-t7 在、kw-t1 不在）；非空行 ≤5；每行显示宽 ≤100（无 wrap 溢出）
 *   B toolrun-static cols=100：同名 7 条静态组 → 组头「bash ×7」+ 可见 2 条单行（kw-a/kw-b）+
 *                  「还有 5 条」；kw-c 不渲染；非空行 ≤5；每行宽 ≤100
 * 判定全过 exit 0；任一失败 exit 1（回归哨兵）。跑法：node scripts/pty-toolrun-probe.cjs
 */
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
// 显示宽（CJK 计 2 列）——string-width 是 ESM，探针走 require 时取 .default
const stringWidth = require(path.join(__dirname, '..', 'node_modules', 'string-width')).default ?? require(path.join(__dirname, '..', 'node_modules', 'string-width'))

function runScene(cols, scene) {
  return new Promise((resolve, reject) => {
    const term = pty.spawn('cmd.exe', ['/c', 'node', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'scripts', 'display-probe-target.tsx'), scene], {
      name: 'xterm-256color',
      cols,
      rows: 24,
      cwd: REPO,
      env: { ...process.env, TERM: 'xterm-256color', CI: '1' },
    })
    let buf = ''
    term.onData((d) => (buf += d))
    term.onExit(({ exitCode }) => {
      if (exitCode !== 0) reject(new Error(`scene ${scene} exit ${exitCode}`))
      else resolve(stripAnsi(buf))
    })
    setTimeout(() => {
      try { killPty(term) } catch { /* 已退 */ }
    }, 20_000)
  })
}

const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ' :: ' + detail}`)
  if (!ok) process.exitCode = 1
}

;(async () => {
  // A：动态区 run 折叠
  const dyn = await runScene(100, 'toolrun-dyn')
  const dynLines = dyn.split(/\r?\n/).filter((l) => l.trim() !== '')
  check('A1 摘要行「bash ×6 已折叠」', dyn.includes('bash ×6 已折叠'))
  check('A2 最新条完整（kw-t7 在）', dyn.includes('kw-t7'))
  check('A3 被折叠条不渲染（kw-t1 不在）', !dyn.includes('kw-t1'))
  check('A4 行收敛 ≤5（7 条不随 N 平铺）', dynLines.length <= 5, `实际 ${dynLines.length} 行`)
  check('A5 无 wrap 溢出（每行 ≤100 列）', dynLines.every((l) => stringWidth(l) <= 100), dynLines.map((l) => stringWidth(l)).join(','))

  // B：静态紧凑组
  const st = await runScene(100, 'toolrun-static')
  const stLines = st.split(/\r?\n/).filter((l) => l.trim() !== '')
  check('B1 组头「bash ×7」', st.includes('bash ×7'))
  check('B2 可见条单行（kw-a/kw-b 在）', st.includes('kw-a') && st.includes('kw-b'))
  check('B3 溢出条不渲染（kw-c 不在）+「还有 5 条」', !st.includes('kw-c') && st.includes('还有 5 条'))
  check('B4 行收敛 ≤5', stLines.length <= 5, `实际 ${stLines.length} 行`)
  check('B5 无 wrap 溢出（每行 ≤100 列）', stLines.every((l) => stringWidth(l) <= 100), stLines.map((l) => stringWidth(l)).join(','))
})().catch((e) => {
  console.error('PROBE_ERROR', e.message)
  process.exit(1)
})
