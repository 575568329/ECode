#!/usr/bin/env node
/**
 * pty 探针树杀收尾（2026-09-03 孤儿根治）。
 *
 * 根因：node-pty 的 pty 终结对 Windows 只终结直连子进程（cmd.exe 一层）——
 * Windows 无进程组/父死亡连带语义，cmd.exe 之下的 tsx wrapper/worker 孙进程原地变孤儿；
 * 且孙进程继承了 ConPTY 句柄，形成「pty 关不掉（孙持有句柄）、孙不退（等 stdin）」
 * 互锁。实证 2026-09-03：探针一轮一实例，20 对孤儿 node 白吃 ~1.5GB（同病昨日 17 例）。
 *
 * killPty(term)：先 pty 原生 kill（保留原语义：优雅关闭），再 taskkill /T /F 按树扫尾
 * （POSIX 无进程组时逐 pid SIGKILL 兜底）。全程吞错——收尾路径不因已退进程炸探针。
 */
function killPty(term) {
  if (term == null || typeof term.kill !== 'function') return
  const pid = term.pid
  try { term['kill']() } catch { /* 已退 */ }
  sweep(pid)
}

/** 按 pid 树杀（taskkill /T 递归；pid 已退则 taskkill 报错吞掉）。 */
function sweep(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      require('node:child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 树已退（pty 原生 kill 已收）——常态 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* 已退/无进程组 */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退 */ }
  }
}

module.exports = { killPty, sweep }
