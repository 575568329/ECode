#!/usr/bin/env node
const { killPty } = require("./pty-treekill.cjs"); // 2026-09-03 孤儿根治：kill 升级树杀
/**
 * TUI 客户端 RSS 专项探针（批2c，P1-A——方案 docs/详设/2026-09-02_后续-真机诊断修复方案 §3.3）。
 *
 * 背景：真机 TUI 客户端 20 分钟涨到 1.15-1.3G（live 每 delta 全量 wrap-ansi 的 O(n²) 垃圾
 * + thinking 全文码点化 + V8 懒回收）。批2a/2b 修渲染路径后，本探针是验收门：
 * 真频率（20ms）滴流 × 25KB×3 轮压真 TimelineView（含 GrayStreaming 增量折叠），
 * 目标进程**自报** rss/heapUsed（stderr 标记——消掉 Windows ConPTY 孙进程归属问题）。
 *
 * 断言（2026-09-02 实测定稿——原「轮间回落」口径在探针规模必 flaky：45MB 小堆 V8 无回收
 * 压力、8s GC 窗口实测仅回落 ~15%，改为有判别力且稳的双口径）：
 *   ① 峰值 rss < 400MB（绝对上限——失控形态直红）
 *   ② 跨轮无棘轮：各轮轮末 rss/heapUsed 相对首轮 ≤ +25%+20MB（每 delta 保留型泄漏/意外
 *     O(n²) 会逐轮爬升；FINAL 仅打印参考——定性靠 /doctor 强制 GC 对照）
 * 现有 80-delta 探针同步瞬间发出且零 RSS 能力，不可复用（审阅 P1-4），故新建。
 * 跑法：node scripts/pty-rss-probe.cjs（满程约 2 分钟；诊断可用 RSS_TICKS/RSS_TURNS 缩短）。
 */
const pty = require('node-pty')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const PEAK_RSS_LIMIT_MB = 400
const RATCHET_RATIO = 1.25
const RATCHET_SLACK_MB = 20

function runOnce() {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(
      'cmd.exe',
      ['/c', 'node', '--expose-gc', path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'scripts', 'display-probe-target.tsx'), 'rss-stream'],
      // NODE_ENV=production——用户态口径（cli 入口默认 production 后的代表性运行）；
      // dev 版 react-reconciler 有每渲染滞留的 devtools 记账（+100MB/轮，GC 不收），
      // 需诊断 dev 形态时手动去掉本行
      { name: 'xterm-256color', cols: 100, rows: 24, cwd: REPO, env: { ...process.env, TERM: 'xterm-256color', CI: '1', NODE_ENV: 'production', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() } },
    )
    let buf = ''
    term.onData((d) => (buf += d))
    term.onExit(({ exitCode }) => {
      if (exitCode !== 0) reject(new Error(`target exit ${exitCode}`))
      else resolve(buf)
    })
    setTimeout(() => {
      try { killPty(term) } catch { /* 已退 */ }
      reject(new Error('probe timeout（200s——满程 3750 tick 实测 ~28ms/tick 含漂移）'))
    }, 200_000)
  })
}

async function main() {
  console.log('[rss-probe] 跑 rss-stream 场景（3 轮 × 25KB @20ms，满程约 2 分钟）…')
  const out = await runOnce()
  const mems = [...out.matchAll(/MEM=([\d.]+)\/([\d.]+)/g)].map((m) => ({ rss: Number(m[1]), heap: Number(m[2]) }))
  const turns = [...out.matchAll(/TURN_END=(\d+) MEM=([\d.]+)\/([\d.]+)/g)].map((m) => ({ turn: Number(m[1]), rss: Number(m[2]), heap: Number(m[3]) }))
  // 轮末强制 GC 后采样（--expose-gc）——棘轮断言的权威口径：GC 后仍逐轮爬升=真保留型泄漏；
  // GC 后掉回基线=懒 GC 垃圾（非泄漏，RSS 棘轮只是未回收观感）
  const turnsGc = [...out.matchAll(/TURN_GC=(\d+) MEM=([\d.]+)\/([\d.]+)/g)].map((m) => ({ turn: Number(m[1]), rss: Number(m[2]), heap: Number(m[3]) }))
  const finalM = out.match(/FINAL=([\d.]+)\/([\d.]+)/)
  if (mems.length === 0 || turns.length < 3 || finalM === null) {
    console.error(`[rss-probe] FAIL 标记不全（MEM=${mems.length} TURN=${turns.length} FINAL=${finalM !== null}）——目标异常输出：\n${out.slice(-800)}`)
    process.exit(1)
  }
  if (turnsGc.length < 3) {
    console.error('[rss-probe] FAIL 缺 TURN_GC 标记（--expose-gc 未生效？）')
    process.exit(1)
  }
  const maxRss = Math.max(...mems.map((m) => m.rss))
  const maxHeap = Math.max(...mems.map((m) => m.heap))
  const finalRss = Number(finalM[1])
  const finalHeap = Number(finalM[2])
  console.log(`[rss-probe] 峰值 rss=${maxRss}MB heap=${maxHeap}MB；末轮后参考值 rss=${finalRss}MB heap=${finalHeap}MB（不作断言——懒 GC 未收观感，定性看 TURN_GC）`)
  console.log(`[rss-probe] 轮末采样（GC 前）：${turns.map((t) => `T${t.turn}=${t.rss}/${t.heap}`).join(' · ')}`)
  console.log(`[rss-probe] 轮末采样（GC 后·权威）：${turnsGc.map((t) => `T${t.turn}=${t.rss}/${t.heap}`).join(' · ')}`)

  const peakOk = maxRss < PEAK_RSS_LIMIT_MB
  const first = turnsGc[0]
  const ratchetOk = turnsGc.every(
    (t) => t.heap <= first.heap * RATCHET_RATIO + RATCHET_SLACK_MB,
  )
  if (peakOk && ratchetOk) {
    console.log(`[rss-probe] PASS（峰值<${PEAK_RSS_LIMIT_MB}MB ✓；GC 后跨轮无棘轮 ✓）`)
    process.exit(0)
  }
  console.error(
    `[rss-probe] FAIL（峰值 ${peakOk ? '✓' : `✗ >${PEAK_RSS_LIMIT_MB}MB`}；GC 后棘轮 ${ratchetOk ? '✓' : `✗ 轮末序列 ${turnsGc.map((t) => t.rss + '/' + t.heap).join('→')}——GC 后仍逐轮爬升=真保留型泄漏`}）`,
  )
  process.exit(1)
}

main().catch((e) => {
  console.error(`[rss-probe] FAIL ${e.message}`)
  process.exit(1)
})
