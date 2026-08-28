/**
 * M12-B6（G1）pty 真机冒烟：起真 TUI（Ink raw mode）→ 真对话（GLM）→ bash 工具 confirm →
 * 执行结果回显。验证 B0-B5 宿主化全链路在真终端下工作。一次性脚本（真网络，不入套件）。
 */
import pty from 'node-pty'
import { setTimeout as sleep } from 'node:timers/promises'

const proc = pty.spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.js'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
})

let buf = ''
let delta = ''
proc.onData((d) => {
  buf += d
  delta += d
})

const waitFor = async (needle, timeoutMs = 60_000, step = 200) => {
  const t0 = Date.now()
  for (;;) {
    if (delta.includes(needle)) {
      const hit = delta
      delta = ''
      return hit
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${needle}（buf 尾部：${buf.slice(-400)}）`)
    await sleep(step)
  }
}

const clearDelta = () => {
  delta = ''
}

try {
  // 1. 启动 → 输入框就绪
  await waitFor('输入消息', 30_000)
  console.log('G1-1 启动 OK：输入框就绪')

  // 2. 真对话（触发 bash 工具 → confirm）
  clearDelta()
  proc.write('运行 bash 命令 echo G1HOSTOK 然后告诉我它的输出\r')
  console.log('G1-2 提交 OK：消息已发送（宿主 prompt 命令）')

  // 3. confirm 弹窗（宿主 Broker approval/requested → ConfirmPrompt 渲染）
  await waitFor('确认', 60_000)
  console.log('G1-3 审批 OK：ConfirmPrompt 弹出（Broker 可答帧驱动）')
  await sleep(600)
  proc.write('\r') // once（默认选中允许）
  console.log('G1-4 应答 OK：回车=once')

  // 4. 工具执行结果回显
  await waitFor('G1HOSTOK', 60_000)
  console.log('G1-5 执行 OK：bash 输出回显（item/completed 事件驱动）')

  // 5. 最终回复到达（assistant 文本）
  await sleep(5_000)
  if (!/G1HOSTOK/.test(buf.slice(-3000))) throw new Error('回复中未含结果')
  console.log('G1-6 完成 OK：assistant 回复含工具结果')

  console.log('\n=== G1 冒烟全过 ===')
} catch (e) {
  console.error('G1 冒烟失败：', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
} finally {
  proc.write('\x03')
  await sleep(800)
  proc.write('\x03') // 双击退出
  await sleep(600)
  proc.kill()
}
