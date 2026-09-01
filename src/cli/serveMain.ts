/**
 * `ecode serve` 常驻模式（M14-C3① 自 cli/index.ts 拆出）。
 *
 * 三职责：启动接管（旧 daemon 身份核验后让位）/serveStop（读注册文件 → PID 校验杀）/
 * serveMode（多项目 ProjectRegistry + HTTP + 飞书 IM gateway + 生命周期：空闲回收 sweep、
 * 防脑裂 watchdog、信号收敛）。入口分流见 cli/index.ts 的 main()。
 */
import { loadConfig, loadDotenvMap } from '../services/config.js'
import { JsonlLogger } from '../services/logger.js'
import { LogStore } from '../services/logstore.js'
import { join } from 'node:path'
import { writeFileSync, chmodSync, readFileSync, rmSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ProjectRegistry } from '../server/projects.js'
import { serveMulti } from '../server/multi.js'
import { FeishuGateway } from '../server/im/feishu.js'
import { RelayClient } from '../server/relayClient.js'
import { DeviceRegistry } from '../server/devices.js'
import { makeDeps } from './assembly.js'

/**
 * M12-B7：`ecode serve` 常驻模式——单会话宿主上 HTTP（多项目 ProjectRegistry 在 B8）。
 * ready 单行 JSON 契约（orca 式）：stdout 只给端口与注册文件路径——**token 不打 stdout**（防本机进程读屏）。
 */
/**
 * M14-C2④：PID 校验杀——kill 前连 /api/health 比对注册 id。PID 回收复用是真实风险
 * （旧注册文件残留 + pid 被系统分给无关进程），身份不符/不可核验一律拒绝（宁可不杀）。
 * 返回是否已发 SIGTERM。
 */
async function killServeByReg(reg: { pid: number; port: number; id?: string }, label: string): Promise<boolean> {
  process.kill(reg.pid, 0) // 探活：已死则 ESRCH 抛给调用方 catch
  // 审阅 P1-3：id 缺失（M14 前旧格式注册文件）同样不可核验——一律拒绝（原仅 id 存在时核验，
  // 陈旧文件+PID 被系统回收给无关进程时盲杀无辜）
  if (reg.id === undefined) {
    process.stdout.write(`${label}：pid ${reg.pid} 注册文件无 id（旧格式），无法核验身份，拒绝盲杀（如确认无误可手动 kill）\n`)
    return false
  }
  try {
    const res = await fetch(`http://127.0.0.1:${reg.port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const info = (await res.json()) as { id?: string | null }
    if (info.id !== reg.id) {
      process.stdout.write(`${label}：pid ${reg.pid} 身份不符（health id 不匹配——疑似 PID 回收复用），拒绝误杀\n`)
      return false
    }
  } catch {
    process.stdout.write(`${label}：pid ${reg.pid} 无法核验身份（health 不可达），拒绝盲杀（如确认无误可手动 kill）\n`)
    return false
  }
  process.kill(reg.pid, 'SIGTERM')
  return true
}

/** M12：`ecode serve stop`——读注册文件 → 身份核验（M14-C2④）→ SIGTERM（常驻+手动停，三家同款） */
export async function serveStop(): Promise<void> {
  const regPath = join(os.homedir(), '.ecode', 'server.json')
  try {
    const reg = JSON.parse(readFileSync(regPath, 'utf8')) as { pid: number; port: number; id?: string }
    const killed = await killServeByReg(reg, 'serve stop')
    if (killed) process.stdout.write(`已停止 serve（pid ${reg.pid}）\n`)
  } catch (e) {
    process.stdout.write(`无需停止：${(e as { code?: string }).code === 'ESRCH' ? '进程已不在' : '注册文件不存在或损坏'}
`)
  }
  try {
    rmSync(regPath, { force: true })
  } catch {
    // 幂等
  }
}

export async function serveMode(): Promise<void> {
  // T3（架构席 P0-2）：接管语义收敛——健康且版本一致的 daemon 在跑 → 不接管、提示后退出 0
  // （旧「无条件 SIGTERM 让位」与 daemon 常驻目标对撞：升级后重开会杀掉跑着的任务）。
  // 接管仅保留给注册陈旧/health 不可达/版本不符（显式升级动作）情形。
  try {
    const regPath = join(os.homedir(), '.ecode', 'server.json')
    const old = JSON.parse(readFileSync(regPath, 'utf8')) as { pid: number; port: number; id?: string; version?: string }
    let pidAlive = true
    try {
      process.kill(old.pid, 0)
    } catch {
      pidAlive = false
    }
    if (pidAlive) {
      let healthy = false
      let sameVersion = false
      try {
        const res = await fetch(`http://127.0.0.1:${old.port}/api/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          const h = (await res.json()) as { ok?: boolean; id?: string; version?: string }
          healthy = h.ok === true && (h.id === undefined || h.id === old.id)
          const myVer = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
          sameVersion = h.version === undefined || h.version === myVer
        }
      } catch {
        // health 不达
      }
      if (healthy && sameVersion) {
        process.stdout.write('已有 daemon 服务中（健康且版本一致）——退出，不接管\n')
        process.exit(0)
      }
      // 版本不符或 health 不达：保留显式升级接管（用户直接敲 serve 即视为升级动作）
      const killed = await killServeByReg(old, 'serve takeover')
      if (!killed) {
        process.stderr.write('✗ 旧 serve 实例无法核验/让位——拒绝并发启动（可先 ecode serve stop 清理）\n')
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 800)) // 等旧进程清锁退出
    } else {
      // 陈旧注册（pid 不在）——清理后直接起
      rmSync(regPath, { force: true })
    }
  } catch {
    // 无旧实例/已死——直接起
  }
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  // T3（架构席 P2-4）：daemon 日志固定用户级目录——detached 后 cwd 锚定在首次拉起目录会漂移
  const serveLogDir = join(os.homedir(), '.ecode', 'logs', 'serve')
  mkdirSync(serveLogDir, { recursive: true })
  const logger = new JsonlLogger(new LogStore(join(serveLogDir, `serve-${sessionId}.jsonl`), sessionId))
  const config = loadConfig()
  const registry = new ProjectRegistry({
    createSession: async (cwd) => {
      // M13-W1：每项目独立 skills/extHooks 实例（多项目 /clear 不串台）+ 会话取自 ProjectHost；
      // ProjectRegistry 本批不动（W2 升维 path→ProjectHost）——对 registry 而言仍是"每项目一个 HostSession"
      const sid = new Date().toISOString().replace(/[:.]/g, '-')
      // model/set 改的是 getConfig() 活引用的 current——共享同一 config 对象会把 A 项目切的
      // 模型串给所有项目；每项目浅克隆隔离 current（providers 只读共享，浅层足够）
      const pcfg = { ...config, current: { ...config.current } }
      const deps = makeDeps(pcfg, logger, sid, cwd, { freshRegistries: true })
      if (deps.project === undefined) throw new Error('ProjectHost missing in makeDeps')
      deps.project.ensure(sid) // 首会话（W2：registry 存 ProjectHost，会话 Map 内含；信封三态按需增会话）
      // M14-C3⑤：serve 路径补加载 skills/plugins（原 load 只在 REPL——serve 下用户技能/插件全
      // 失效是功能缺口）。冷启动时点执行（acquire 内 await），懒项目零成本；plugin 命令装进
      // 本项目 commands 实例（C3④——不跨项目串台）
      await deps.skillRegistry
        .load({ builtinCommandNames: deps.commands.list().map((c) => c.name) })
        .catch((e: unknown) => logger.warn('skill', 'load_failed', { cwd, message: e instanceof Error ? e.message : String(e) }))
      for (const w of deps.skillRegistry.loadWarnings) logger.warn('skill', 'load_warning', { cwd, message: w })
      logger.info('skill', 'loaded', { cwd, count: deps.skillRegistry.list().length })
      const pluginWarnings = await deps.pluginLoader
        ?.loadAll(deps.skillRegistry, deps.mcpManager, deps.commands)
        .catch((e: unknown) => [`plugin loadAll 失败：${e instanceof Error ? e.message : String(e)}`]) ?? []
      for (const w of pluginWarnings) logger.warn('plugin', 'load_warning', { cwd, message: w })
      if (deps.pluginLoader !== null) {
        logger.info('plugin', 'loaded', { cwd, count: deps.pluginLoader.list().length })
      }
      return deps.project
    },
  })
  registry.register(process.cwd())
  // 多项目 serve（B8.2）：默认项目=启动 cwd；/api/projects 列表 + /api/p/<path>/ 项目路由
  // M13-W3（绑定语义显式化 + 启动体验）：ECODE_SERVE_HOST 三态（loopback 默认/局域网 IP/LAN 全网卡）；
  // 非 loopback 强制 ECODE_SERVER_PASSWORD（serveMulti 同款校验双保险）；启动打印完整访问 URL。
  // F-18 尾巴（批2c）：ECODE_SERVE_* 与主链同款 dotenvMap 回退——.env 里写 ECODE_SERVE_HOST
  // 因 F-18 根修不再提升进 process.env，此前会静默失效（永远 127.0.0.1）。优先级不变：
  // 外部注入（shell export/spawn env）> .env 文件
  const dotenvMap = loadDotenvMap(process.cwd())
  // T3 安全（§4.5.2）：auto-spawn 拉起的 daemon 对 serve 绑定三元组（HOST/PORT/SERVER_PASSWORD）
  // 只认外部环境变量、不回退项目 .env——否则恶意仓库 .env 可经日常 ecode 静默制造局域网常驻暴露
  const autoSpawn = process.env.ECODE_AUTO_SPAWN === '1'
  const envOr = (k: string): string | undefined => {
    const fromEnv = process.env[k]
    if (autoSpawn && (k === 'ECODE_SERVE_HOST' || k === 'ECODE_SERVE_PORT' || k === 'ECODE_SERVER_PASSWORD')) {
      return fromEnv
    }
    return fromEnv ?? dotenvMap[k]
  }
  const serveHost = envOr('ECODE_SERVE_HOST') ?? '127.0.0.1'
  const servePassword = envOr('ECODE_SERVER_PASSWORD') ?? ''
  const isLoopbackServe = serveHost === '127.0.0.1' || serveHost === '::1' || serveHost === 'localhost'
  if (!isLoopbackServe && servePassword === '') {
    process.stderr.write('✗ 非 loopback 绑定（ECODE_SERVE_HOST=' + serveHost + '）必须设置 ECODE_SERVER_PASSWORD——拒绝启动（防裸奔局域网）\n')
    process.exit(1)
  }
  // M13-W5：web/dist 托管（存在即挂——开发期没 build 则纯 API 形态不变）。
  // 解析序：ECODE_WEB_DIR 显式覆盖 > 包内相对（import.meta.url——tsx 源码跑=仓库根/web/dist，
  // npm 发布跑=包根/web/dist；files 字段带 web/dist）> 不托管。不再看 cwd（其他项目目录起 serve
  // 时 cwd/web/dist 是错误形态——审阅修正）
  const webDirFromEnv = envOr('ECODE_WEB_DIR')
  const webDirFromPkg = fileURLToPath(new URL('../../web/dist', import.meta.url))
  const webDirCandidate = webDirFromEnv !== undefined && webDirFromEnv !== '' ? webDirFromEnv : webDirFromPkg
  const webDir = existsSync(webDirCandidate) ? webDirCandidate : undefined
  // T3：附着版本比对基准 + 主机别名（多机区分；顶栏/web 显示「当前连的是谁」）
  const myVer = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const daemonName = envOr('ECODE_SERVE_NAME') ?? os.hostname()
  // F-27：/api/cmd {op:'stop'} 优雅停机——与信号 handler 同一收敛路径（断 mux → registry
  // dispose（锁释放/审批收敛）→ 日志 LogStore 同步 flush → exit）。watchdog 兼容：shutdown 前删
  // 注册文件，防 watchdog 读到陈旧 id 误判「被接管」（其实是自己停）。本机 token 持有者即主人。
  const stopServe = (): void => {
    try {
      rmSync(join(os.homedir(), '.ecode', 'server.json'), { force: true })
    } catch {
      /* 已删/不可达——信号路径兜底 */
    }
    shutdown(0)
  }
  // R1：配对设备凭据注入（devices.json 未吊销条目→extraCredentials device 类——不可 confirm 豁免）
  const deviceRegistry = new DeviceRegistry()
  const deviceCreds: Array<{ secret: string; class: 'device' }> = []
  for (const d of deviceRegistry.list()) {
    if (d.secret !== '') deviceCreds.push({ secret: d.secret, class: 'device' })
  }
  if (deviceCreds.length > 0) logger.info('daemon', 'devices_loaded', { count: deviceCreds.length })
  // R2：relay 出站客户端——鸡生蛋解法：client 先建（端口/凭据校验后置 bindDaemon），
  // serveMulti 经 getter 间接引用（devices.relay: () => relayClient），起完 HTTP 再 start()
  let relayClient: RelayClient | undefined
  if (config.relay !== undefined) {
    relayClient = new RelayClient({
      hostBase: config.relay.hostBase ?? `${config.relay.server.replace(/\/$/, '')}/ecode-tunnel`,
      phoneBase: config.relay.phoneBase,
      hostId: config.relay.hostId ?? os.hostname(),
      hostToken: config.relay.hostToken,
      hostName: config.relay.name ?? daemonName,
      appVersion: myVer,
      daemonPort: 0,
      verifyAuth: () => null,
      log: (level, event, payload) =>
        level === 'error' ? logger.error('daemon', event, payload) : level === 'warn' ? logger.warn('daemon', event, payload) : logger.info('daemon', event, payload),
    })
  }
  const srv = await serveMulti(
    { registry, defaultCwd: process.cwd() },
    {
      port: Number(envOr('ECODE_SERVE_PORT') ?? 0),
      host: serveHost,
      password: servePassword,
      id: sessionId,
      onStop: stopServe,
      version: myVer,
      name: daemonName,
      extraCredentials: deviceCreds,
      ...(webDir !== undefined ? { webDir } : {}),
      // R2：设备管理面（配对 offer 的 relay 段依赖 relayClient 在线）
      ...(config.relay !== undefined || deviceCreds.length > 0
        ? {
            devices: {
              deviceRegistry,
              relay: () => relayClient,
              webOrigin: config.relay !== undefined ? config.relay.server.replace(/\/$/, '') + '/ecode' : undefined,
              audit: (event: string, payload: Record<string, unknown>) => logger.info('approval', event, payload),
            },
          }
        : {}),
    },
  )
  if (relayClient !== undefined) {
    relayClient.bindDaemon(srv.port, srv.verify ?? (() => null))
    relayClient.start()
    logger.info('daemon', 'relay_starting', { hostId: relayClient.hostId })
  }
  // 注册文件（B8 daemon 生命周期的锚点）：0600，含 token——客户端从这里读。
  // T3：+version（附着前版本比对）+name（多机区分）；tmp+rename 原子写（防撕裂，架构席 P2-3）
  const regPath = join(os.homedir(), '.ecode', 'server.json')
  const regTmp = `${regPath}.tmp-${process.pid}`
  writeFileSync(regTmp, JSON.stringify({ id: sessionId, port: srv.port, token: srv.token, pid: process.pid, version: myVer, name: daemonName }, null, 2), { mode: 0o600 })
  try {
    chmodSync(regTmp, 0o600)
  } catch {
    /* 非 POSIX（win32）chmod 无强制力——文档披露不阻断 */
  }
  renameSync(regTmp, regPath)
  console.log(JSON.stringify({ type: 'ready', schemaVersion: 1, bound: `${serveHost}:${srv.port}`, register: regPath }))
  // 局域网形态打印手机可直接点击的访问 URL（半行代码消除"我该在手机输什么"的摩擦——审阅 P1）
  if (!isLoopbackServe) {
    const lanIp = Object.values(os.networkInterfaces())
      .flat()
      .find((n): n is os.NetworkInterfaceInfo => n !== undefined && n.family === 'IPv4' && n.internal === false)?.address
    if (lanIp !== undefined) process.stdout.write(`Mobile: http://${lanIp}:${srv.port}\n`)
    process.stdout.write('提示：DHCP 可能变动局域网 IP——建议为公司电脑配置静态 IP（中继形态 M14 后此问题消失）\n')
  }
  // M13-W8：飞书 IM gateway（配置了凭据才激活——长连接免公网，公司电脑零暴露）
  let feishuGw: FeishuGateway | undefined
  if (config.feishu !== undefined && config.feishu.appId !== '' && config.feishu.appSecret !== '') {
    const projectRoot = process.cwd().split(String.fromCharCode(92)).join('/')
    feishuGw = new FeishuGateway({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      allowUsers: config.feishu.allowUsers, // 白名单（缺省/空=拒绝所有——审阅 P0-1）
      logger,
      project: projectRoot,
      sendCommand: async (sessionId, op) => {
        // 真新建特判（审阅 P1-3：飞书 /new 曾只解绑定，下一条消息 ensureDefault 复用旧默认
        // 会话——「新建」实为继续旧聊；与 multi.ts 信封层拦截同语义）
        if ((op as { op?: string }).op === 'session/new') {
          const r = await registry.acquire(projectRoot, { confirm: true })
          if (!r.ok || r.host === undefined) return { ok: false, error: 'project acquire failed' }
          const sid = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`
          r.host.ensure(sid)
          return { ok: true, sessionId: sid }
        }
        const r = await registry.acquire(projectRoot, { confirm: true })
        if (!r.ok || r.host === undefined) return { ok: false, error: 'project acquire failed' }
        const conv = sessionId !== undefined ? r.host.conversation(sessionId) ?? (await r.host.ensureRestore(sessionId)) : r.host.ensureDefault(`${new Date().toISOString().replace(/[:.]/g, '-')}-im`)
        const result = (await conv.send(op as Parameters<typeof conv.send>[0])) as { ok: boolean; error?: string; sessionId?: string; value?: unknown }
        return { ...result, sessionId: sessionId ?? r.host.currentSessionId }
      },
      subscribe: (handler) => {
        // mux 语义的最小进程内形态：订阅默认项目全部会话（registry 层面——W8 简化走 registry 快照轮询不可行，
        // 直接用 ProjectHost 会话订阅：acquire 后 conversationsSnapshot 订阅现有+onSessionEvent 增量）
        const unsubs: Array<() => void> = []
        void registry.acquire(projectRoot, { confirm: true }).then((r) => {
          if (!r.ok || r.host === undefined) return
          const attach = (): void => {
            // 审阅 P1-2：gateway 全量订阅但只转发绑定命中的会话（onFrame 未绑定直接 return）——
            // 观察型连接必须声明 canAnswer:false，否则 sensitive 审批的"零可应答者 fail-closed"
            // 被 phantom subscriber 撑破（审批挂 15min 超时自动拒——C2⑧ 同病此处曾回归）
            for (const [sid, conv] of r.host!.conversationsSnapshot()) {
              unsubs.push(conv.subscribe((ev) => handler({ project: projectRoot, sessionId: sid, ev }), { canAnswer: false }))
            }
            unsubs.push(
              r.host!.onSessionEvent((kind, info) => {
                if (kind === 'created') {
                  const conv = r.host!.conversation(info.sessionId)
                  if (conv !== undefined) unsubs.push(conv.subscribe((ev) => handler({ project: projectRoot, sessionId: info.sessionId, ev }), { canAnswer: false }))
                }
              }),
            )
          }
          attach()
        })
        return () => {
          for (const u of unsubs) u()
        }
      },
      listSessions: async () => {
        const r = await registry.acquire(projectRoot, { confirm: true })
        if (!r.ok || r.host === undefined) return []
        const conv = r.host.ensureDefault(`list-${Date.now()}`)
        const res = (await conv.send({ op: 'session/list' })) as { ok: boolean; value?: unknown }
        return Array.isArray(res.value) ? (res.value as Array<{ sessionId: string; firstUser: string; running?: boolean }>) : []
      },
    })
    void feishuGw.start().catch((e: unknown) => {
      process.stderr.write(`飞书 gateway 启动失败：${e instanceof Error ? e.message : String(e)}
`)
      feishuGw = undefined
    })
  }

  // 空闲回收（30 分钟 sweep；审批/UI 挂起不回收）
  // M13-W2：会话级回收（项目基座常驻——Q5 两家实证）；sessionIdleMinutes 默认 120，0=不收
  const sessionIdleMinutes = config.sessionIdleMinutes ?? 120
  const sweep = sessionIdleMinutes > 0 ? setInterval(() => void registry.sweepSessions(sessionIdleMinutes), 60_000) : null
  // 防脑裂（opencode 同款）：10s 校验注册 id 仍是自己——被更新版接管即让位自杀
  const myId = sessionId
  const watchdog = setInterval(() => {
    try {
      const cur = JSON.parse(readFileSync(join(os.homedir(), '.ecode', 'server.json'), 'utf8')) as { id: string }
      if (cur.id !== myId) {
        clearInterval(watchdog)
        if (sweep !== null) clearInterval(sweep)
        registry.disposeAll()
        process.exit(0)
      }
    } catch {
      // 注册文件被删（stop 已发 SIGTERM——此路径兜底）
    }
  }, 10_000)
  void watchdog
  // 审阅 P1-4：serve 分流先于 main 的 handler 注册——此处自管生命周期：
  // 一次信号 = 全量清理后退出（server.close 断流 → registry.disposeAll（锁释放/审批收敛）→ exit）
  const shutdown = (code: number): void => {
    if (sweep !== null) clearInterval(sweep)
    void (async () => {
      feishuGw?.dispose()
      relayClient?.dispose()
      await srv.close()
      registry.disposeAll()
      process.exit(code)
    })()
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.once(sig, () => shutdown(0))
  }
  process.on('uncaughtException', (e) => {
    process.stderr.write(`serve 崩溃：${e instanceof Error ? e.message : String(e)}
`)
    shutdown(1)
  })
  // 常驻 daemon 显式收敛 unhandledRejection（Node≥15 默认 throw 直接退进程——审阅 P1-2：
  // 曾只有 TUI 分支注册此 handler，serve 路径异步异常一击即溃全部项目）
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`serve 异步拒绝（不退出）：${reason instanceof Error ? reason.message : String(reason)}\n`)
  })
  await new Promise<never>(() => {}) // 常驻（无客户端不退——生命周期由上方 handler 管）
}
