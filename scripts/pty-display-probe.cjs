/**
 * 显示宽度动态化真 pty 探针（2026-09-02 用户拍板批的实机验证）：
 *   P1 收起预览动态宽度：cols=120 时 120a 截到 109a+…（110 列）；cols=200 时不截（120a 全显）
 *      —— 证明宽度跟随终端而非固定 80
 *   P2 thinking 尾部滚动：300x 无换行在 cols=100 → 显示最后 ~N 个 x（… 前缀在左，
 *      右边=最新内容；旧 clipLine 裁头部时右边是开头 x 串）
 *   P3 换行从头显示：'old line…\nshort new line ok' → 显示 short 新行、不含 old line
 * 判定全过 exit 0；任一失败 exit 1（可作 CI/回归哨兵）。
 * 跑法：node scripts/pty-display-probe.cjs
 */
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

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
      try { term.kill() } catch { /* 已退 */ }
    }, 20_000)
  })
}

const longestARun = (text) => {
  const m = text.match(/a+/g)
  return m ? Math.max(...m.map((s) => s.length)) : 0
}
const longestXRun = (text) => {
  const m = text.match(/x+/g)
  return m ? Math.max(...m.map((s) => s.length)) : 0
}

;(async () => {
  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
  }

  // P1a：cols=120，输出 120a —— 预览宽=120-10=110 → 109a + …（旧固定 80 是 79a）
  try {
    const out = await runScene(120, 'preview-120')
    const run = longestARun(out)
    check('P1a cols=120 预览截 109a+…（动态 110 列）', run === 109, `最长 a 串=${run}（期望 109；固定 80 时=79）`)
  } catch (e) { check('P1a', false, e.message) }

  // P1b：cols=200，输出 120a —— 宽度 190 > 120 → 不截（全显，无 … 跟随）
  try {
    const out = await runScene(200, 'preview-120')
    const run = longestARun(out)
    check('P1b cols=200 宽度内不截（120a 全显）', run === 120, `最长 a 串=${run}（期望 120）`)
  } catch (e) { check('P1b', false, e.message) }

  // P2：cols=100，300x 无换行 —— 右边显示最新尾部（长 x 串 ≈ 剩余宽度，且 < 300）
  try {
    const out = await runScene(100, 'tail-none')
    const run = longestXRun(out)
    const hasLeftEllipsis = /…x+/.test(out)
    check(
      'P2 无换行尾部滚动（右边=最新 x，…在左）',
      run >= 60 && run <= 95 && hasLeftEllipsis,
      `x 串=${run}（期望 60~95 区间=剩余宽度；旧裁头时=开头固定段）…前缀=${hasLeftEllipsis}`,
    )
  } catch (e) { check('P2', false, e.message) }

  // P3：换行后从头显示新行（不含 old line / o 串）
  try {
    const out = await runScene(100, 'tail-newline')
    const showsNew = out.includes('short new line ok')
    const hidesOld = !/o{20,}/.test(out)
    check('P3 换行从头显示新行', showsNew && hidesOld, `新行可见=${showsNew}，旧行 o 串不可见=${hidesOld}`)
  } catch (e) { check('P3', false, e.message) }

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed.length}/${results.length} 项失败`)
  process.exit(failed.length === 0 ? 0 : 1)
})()
