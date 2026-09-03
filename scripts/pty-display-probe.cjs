const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀（term.kill 只杀 cmd.exe 一层，tsx 孙进程变孤儿）
/**
 * 显示宽度动态化真 pty 探针（2026-09-02 用户拍板批的实机验证）：
 *   P1 收起预览动态宽度：cols=120 时 120a 截到 109a+…（110 列）；cols=200 时不截（120a 全显）
 *      —— 证明宽度跟随终端而非固定 80
 *   P2 thinking 尾部滚动：300x 无换行在 cols=100 → 显示最后 ~N 个 x（… 前缀在左，
 *      右边=最新内容；旧 clipLine 裁头部时右边是开头 x 串）
 *   P3 换行从头显示：'old line…\nshort new line ok' → 显示 short 新行、不含 old line
 *   P4-P7 StatusBar 精简批（2026-09-02 用户点名：可读短词 + 内存段 + 宽度守卫）：
 *   P4 cols=120 全段渲染（含内存段 R350M、⏵⏵ edits/MCP 2/3/后台运行）
 *   P5 cols=75 守卫丢段（daemon/mcp 先牺牲，mem/ctx/model 在场）
 *   P6 cols=24 极窄只留 model（守卫终点）
 *   P7 cols=84 App 同行组合（busy 提示占宽参与守卫；状态行不 wrap）
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
      try { killPty(term) } catch { /* 已退 */ }
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

  // P4：cols=120 全段——箭头短词 + 中文 daemon + 内存段在场（R350M）
  try {
    const out = await runScene(120, 'status-full')
    const segs = { '#3/25': out.includes('#3/25'), 'T45k': out.includes('T45k'), 'ctx 45k/200k': out.includes('ctx 45k/200k'), 'MCP 2/3': out.includes('MCP 2/3'), '⏵⏵ edits': out.includes('⏵⏵ edits'), '¥0.003': out.includes('¥0.003'), 'R350M': /R\d+M/.test(out), '后台运行': out.includes('后台运行') }
    const ok = Object.values(segs).every(Boolean)
    const noBrand = !out.includes('ECode')
    check('P4 全段渲染（箭头短词/中文段 + 内存段 R350M）', ok && noBrand, `${JSON.stringify(segs)} 无品牌前缀=${noBrand}`)
  } catch (e) { check('P4', false, e.message) }

  // P5：cols=75 守卫——全宽 92 → 丢 daemon/mcp 收在 75（mem/ctx/model 在场）
  try {
    const out = await runScene(75, 'status-narrow')
    const drops = !out.includes('后台运行') && !out.includes('MCP 2/3')
    const keeps = /R\d+M/.test(out) && out.includes('ctx 45k/200k') && out.includes('glm-5.3-flash')
    check('P5 守卫丢段（daemon/mcp 先牺牲）', drops && keeps, `丢弃观测段=${drops}，保留 mem/ctx/model=${keeps}`)
  } catch (e) { check('P5', false, e.message) }

  // P6：cols=24 极窄——只留 model（守卫终点；30 列下 model+ctx=28 恰放得下会保 ctx，24 才是终点）
  try {
    const out = await runScene(24, 'status-slim')
    const model = out.includes('glm-5.3-flash')
    const dropped = !out.includes('ctx') && !out.includes('#3/25') && !/R\d/.test(out)
    check('P6 极窄只留 model', model && dropped, `model 在场=${model}，其余段退场=${dropped}`)
  } catch (e) { check('P6', false, e.message) }

  // P7：cols=84 App 同行组合——busy 提示在场（^C中断 ^T展开）且状态行不 wrap
  //     （wrap 会破坏 allocateDynamic「StatusBar 恒 1 行」帧账 → win32 全清，守卫的意义所在；
  //      avail=84-24=60：全宽 92 → 丢 daemon/mcp/mem 后 55 ≤ 60，行宽 55+24=79 ≤ 84 留 5 列裕量）
  try {
    const out = await runScene(84, 'status-hint')
    const hint = out.includes('^C中断') && out.includes('^T展开')
    const noWrap = !/\n\s*45k\/200k/.test(out) && !/\n\s*后台/.test(out)
    check('P7 busy 提示同行且状态行不 wrap', hint && noWrap, `提示在场=${hint}，无跨行拆段=${noWrap}`)
  } catch (e) { check('P7', false, e.message) }

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed.length}/${results.length} 项失败`)
  process.exit(failed.length === 0 ? 0 : 1)
})()
