/**
 * 全功能走查·第二轮：斜杠命令全集 pty 清扫（20 条逐条驱动）。
 * 每条命令：两段式回车提交 → 断言预期 UI 形态 → Esc（多按保净）回到主输入。
 * 环境：隔离 USERPROFILE + ECODE_FORCE_EMBEDDED（防附着 daemon/读真 config）+ mock LLM
 * （/doctor 注入草稿不发送；其余命令均 UI 面）。/undo 用临时 git 沙盒 cwd。
 */
const pty = require('node-pty')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const REPO = path.resolve(__dirname, '..')
const strip = (s) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9AB]/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeEnv(port, home, cwd) {
  return {
    ...process.env,
    ECODE_FORCE_EMBEDDED: '1',
    USERPROFILE: home,
    HOME: home,
    ECODE_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'dummy-key',
    ECODE_MODEL: 'mock-model',
    ECODE_ASCII_SYMBOLS: '',
  }
}

async function main() {
  // mock LLM：任何请求回一短句（不应被用到——命令都是 UI 面）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify(o)}\n\n`)
    sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    sse('content_block_stop', { type: 'content_block_stop' })
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    sse('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // 隔离 home（空 config 首启会生成模板——config 面板可开）+ git 沙盒 cwd（/undo）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-slash-home-'))
  fs.mkdirSync(path.join(home, '.ecode'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ecode', 'config.json'), JSON.stringify({
    providers: { m: { type: 'anthropic', baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', models: ['mock-model'] } },
    current: { name: 'm', model: 'mock-model' },
    maxIterations: 5,
  }))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-slash-cwd-'))
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello\n')
  require('child_process').execSync('git init -q && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm init', { cwd })

  const proc = pty.spawn('cmd.exe', ['/c', 'npx', 'tsx', 'src/cli/index.ts'], {
    cwd: REPO,
    env: makeEnv(port, home, cwd),
    cols: 110,
    rows: 40,
  })
  let out = ''
  proc.onData((d) => (out += d))
  const has = (s) => strip(out).includes(s)
  const waitUntil = async (re, timeout = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (re.test(strip(out))) return true
      await sleep(150)
    }
    return false
  }
  const results = []
  const check = (name, ok, note = '') => {
    results.push({ name, ok })
    console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`)
  }
  const sendCmd = async (cmd, expectRe, timeout = 12000) => {
    const before = out.length
    proc.write('/' + cmd)
    await sleep(350)
    proc.write('\r')
    await sleep(350)
    proc.write('\r')
    const ok = await waitUntil(expectRe, timeout)
    const seg = strip(out.slice(before))
    // 清状态：Esc 两连（间隔 700ms > 双击退出 500ms 窗——快速连按会触发优雅退出杀掉 TUI，
    // 首版探针 Esc×5 间隔 180ms 自伤实证）；关面板→清搜索/待清态
    proc.write('\x1b')
    await sleep(700)
    proc.write('\x1b')
    await sleep(700)
    return { ok, seg }
  }
  /** 面板关闭后主输入在场性守卫（TUI 意外退出时立即中止并报因） */
  const alive = () => strip(out).includes('输入消息')

  // 启动
  const started = await waitUntil(/输入消息/, 25000)
  check('TUI 启动', started)

  // —— 逐条命令（两段式回车；expect 为开面板/提示的正则）——
  let r
  r = await sendCmd('help', /命令|快捷键|\/model/)
  check('/help 帮助列表', r.ok)

  r = await sendCmd('clear', /.*/)
  // clear 断言难（无历史可清）——只验证不炸+主输入还在
  check('/clear 不炸（主输入仍可用）', strip(out).includes('输入消息'))

  r = await sendCmd('model', /mock-model|选择模型|模型/)
  check('/model 模型面板', r.ok)

  r = await sendCmd('history', /会话|历史|无历史|恢复/)
  check('/history 历史面板', r.ok)

  r = await sendCmd('setup', /向导|配置|provider|选择/)
  check('/setup 向导', r.ok)

  r = await sendCmd('compact', /压缩|无可压缩|会话|上下文/)
  check('/compact 压缩（提示或执行）', r.ok)

  r = await sendCmd('cost', /成本|费用|token|¥|0/)
  check('/cost 成本输出', r.ok)

  r = await sendCmd('stats', /统计|会话|token|输入|输出/)
  check('/stats 统计', r.ok)

  r = await sendCmd('devices', /配对|设备/)
  check('/devices 设备面板', r.ok)

  r = await sendCmd('skill', /技能|skill|空|无/)
  check('/skill 技能面板', r.ok)

  r = await sendCmd('mcp', /MCP|服务器|无/)
  check('/mcp MCP 面板', r.ok)

  r = await sendCmd('plugin', /插件|plugin|无|安装/)
  check('/plugin 插件面板', r.ok)

  r = await sendCmd('warnings', /告警|没有未读|空/)
  check('/warnings 告警中心', r.ok)

  r = await sendCmd('sandbox', /沙箱|档位|default|read-only/)
  check('/sandbox 沙箱面板（四档）', r.ok)

  r = await sendCmd('undo', /撤销|上次提交|autoCommit|没有|无/)
  check('/undo git 撤销（沙盒仓库提示）', r.ok)

  r = await sendCmd('doctor', /诊断|自检|doctor|记忆|检查/)
  check('/doctor 自检 prompt 注入', r.ok)

  r = await sendCmd('config', /配置|页签|常规|原始/)
  check('/config 配置面板（三页签）', r.ok)

  // /skill-create（流程型——只断言首屏出现）+ /rewind /restart 已有专项探针不重跑
  r = await sendCmd('skill-create', /技能|skill|创建|名字|名称/)
  check('/skill-create 创建流程', r.ok)

  // 覆盖层清场（顺序敏感）：先窗内双击 Esc 清 /doctor 注入的大草稿（草稿非空=清空语义，
  // 不会误开 rewind）→ 再单刀 Ctrl+C 关残留覆盖层（第二刀会撞「再按一次退出」长窗杀 TUI——
  // 首版实证）→ 回显探针
  proc.write('\x1b')
  await sleep(250)
  proc.write('\x1b')
  await sleep(900)
  proc.write('\x03')
  await sleep(900)
  if (!alive()) {
    check('TUI 存活守卫', false, '清理后 TUI 不在——检查帧')
    console.log('----- 帧尾 -----\n' + strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-14).join('\n'))
    proc.kill()
    server.close()
    process.exit(1)
  }

  // 收尾健康：主输入仍活
  const beforeEcho = out.length
  proc.write('尾部回显探针')
  await sleep(600)
  const tailOk = strip(out.slice(beforeEcho)).includes('尾部回显探针')
  check('收尾调度活（草稿回显）', tailOk)
  if (!tailOk) {
    console.log('----- 尾部帧 -----')
    console.log(strip(out).split('\n').map((l) => l.replace(/\r/g, '').trimEnd()).filter(Boolean).slice(-16).join('\n'))
  }

  const failed = results.filter((x) => !x.ok)
  console.log(`\n# 结论：${results.length - failed.length}/${results.length} 过${failed.length > 0 ? '，失败：' + failed.map((f) => f.name).join(' / ') : ''}`)
  proc.kill()
  server.close()
  try { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }) } catch {}
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('driver error:', e)
  process.exit(1)
})
