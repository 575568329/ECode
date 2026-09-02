#!/usr/bin/env node
// Ctrl+C 中断止损回归哨兵（批1a，方案 docs/详设/2026-09-02_后续-真机诊断修复方案 §1.3）
//
// 实证背景（2026-09-02 四角色审阅）：openai v7 create(body, options) 的 signal 只认**第二参**
// RequestOptions——曾传进 body 形参导致 signal 从未到达 fetch（Ctrl+C 34-54s 不收敛的真根因，
// 且 abort 后端点继续白跑生成）。本哨兵锁死正确传法并双断言：
//   ① 客户端：abort 后 ≤2s 流迭代终止且未收满 chunks（中断及时性）
//   ② 服务器：abort 后 ≤2s socket 断开（= 端点停止生成，止损面——req.on('close') 在正常完成
//     也触发，不作为判据；用 socket 级计数，修掉早期复现脚本的时序巧合推理链）
// 依赖 repo node_modules 的 openai@7（npm 依赖，非自带）；用法：
//   node scripts/abort-stream-probe.mjs    退出码 0=过 / 1=败 / 2=编排失败
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const ABORT_AFTER_MS = 3000 // 建流后 3s abort（此时流才进行 1/10）
const CONVERGE_BUDGET_MS = 2000 // abort→迭代终止/socket 断开的预算
const DRIP_MS = 300
const TOTAL_CHUNKS = 100 // 100×300ms=30s 自然时长

// ---------- server 角色：慢滴 SSE + socket 级断开计时 ----------
function runServer() {
  const server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let i = 0
    const timer = setInterval(() => {
      i++
      if (i <= TOTAL_CHUNKS) {
        res.write(`data: {"id":"r1","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n`)
      } else {
        res.write(`data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":${TOTAL_CHUNKS}}}\n\n`)
        res.write('data: [DONE]\n\n')
        clearInterval(timer)
        res.end()
        console.log('STREAM_FINISHED_NATURALLY')
      }
    }, DRIP_MS)
  })
  // socket 级计数：与请求语义解耦，断开必触发
  server.on('connection', (socket) => {
    console.log(`SOCKET_OPENED_AT=${Date.now()}`)
    socket.on('close', () => console.log(`SOCKET_CLOSED_AT=${Date.now()}`))
  })
  server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`))
  setTimeout(() => process.exit(3), (TOTAL_CHUNKS + 20) * DRIP_MS).unref() // 兜底自杀
}

// ---------- client 角色：signal 第二参 + 中途 abort ----------
async function runClient(port) {
  const { default: OpenAI } = await import('openai')
  const controller = new AbortController()
  const client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' })
  const t0 = Date.now()
  let chunks = 0
  let abortAt = 0
  try {
    const stream = await client.chat.completions.create(
      {
        model: 'probe-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      },
      // ★ 被测形态：signal 在第二参（历史 bug：混进上面的 body 对象——signal 从未到达 fetch）
      { signal: controller.signal },
    )
    console.log(`STREAM_BUILT elapsed=${Date.now() - t0}`)
    setTimeout(() => {
      abortAt = Date.now()
      console.log('ABORT_TRIGGERED')
      controller.abort()
    }, ABORT_AFTER_MS)
    for await (const _chunk of stream) chunks++ // eslint-disable-line @typescript-eslint/no-unused-vars
    console.log(`ITER_ENDED chunks=${chunks} elapsed=${Date.now() - t0}`)
  } catch (e) {
    // abort 逐出形态两种都算正常到达：openai 静默收尾（不抛）走上面 ITER_ENDED；
    // 抛 AbortError/APIUserAbortError 也是正确行为（signal 真的触达了流）
    console.log(`ITER_THREW name=${e?.name} chunks=${chunks} elapsed=${Date.now() - t0}`)
  }
  const converged = abortAt > 0 && Date.now() - abortAt <= CONVERGE_BUDGET_MS + 100 && chunks < TOTAL_CHUNKS + 1
  console.log(`CLIENT_VERDICT pass=${converged} abortToNow=${abortAt > 0 ? Date.now() - abortAt : 'n/a'} chunks=${chunks}/${TOTAL_CHUNKS + 1}`)
  process.exit(converged ? 0 : 1)
}

// ---------- 编排：起 server → 起 client → 双判 ----------
async function orchestrate() {
  const selfPath = fileURLToPath(import.meta.url)
  const serverProc = spawn(process.execPath, [selfPath, '--role=server'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: process.cwd(),
  })
  let port = 0
  let socketOpenedAt = 0
  let socketClosedAt = 0
  serverProc.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      const p = line.match(/PORT=(\d+)/)
      if (p && !port) {
        port = Number(p[1])
        startClient()
      }
      const so = line.match(/SOCKET_OPENED_AT=(\d+)/)
      if (so) socketOpenedAt = Number(so[1])
      const sc = line.match(/SOCKET_CLOSED_AT=(\d+)/)
      if (sc) socketClosedAt = Number(sc[1])
    }
  })
  let clientExit = -1
  let clientVerdict = false
  function startClient() {
    const client = spawn(process.execPath, [selfPath, '--role=client', String(port)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: process.cwd(),
    })
    client.stdout.on('data', (d) => {
      const s = String(d)
      if (/CLIENT_VERDICT pass=true/.test(s)) clientVerdict = true
      process.stdout.write('[client] ' + s)
    })
    client.on('exit', (code) => {
      clientExit = code ?? 1
      finish()
    })
  }
  let finished = false
  function finish() {
    if (finished) return
    finished = true
    // client 已退，等 socket 断开证据最多再留预算时长
    setTimeout(() => {
      serverProc.kill()
      const serverOk = socketClosedAt > 0 // socket 真的断了（止损端点生成）
      console.log(`SERVER_VERDICT pass=${serverOk} socketClosedAt=${socketClosedAt || 'never'}`)
      const ok = clientExit === 0 && clientVerdict && serverOk
      console.log(ok ? 'PROBE PASS' : 'PROBE FAIL')
      process.exit(ok ? 0 : 1)
    }, CONVERGE_BUDGET_MS)
  }
  setTimeout(() => {
    console.log('PROBE FAIL (orchestration timeout)')
    serverProc.kill()
    process.exit(2)
  }, (TOTAL_CHUNKS + 20) * DRIP_MS).unref()
}

const role = process.argv.find((a) => a.startsWith('--role='))
if (role === '--role=server') runServer()
else if (role === '--role=client') runClient(Number(process.argv[process.argv.length - 1]))
else await orchestrate()
