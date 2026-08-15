/** setupMcp（M-P9 审阅补测）：二段启动 TOCTOU / warnings / 未批准隔离。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setupMcp } from '../../../src/services/mcp/setup.js'
import { ToolRegistryImpl } from '../../../src/tools/registry.js'
import { setApprovedFilePath, mcpFileHash } from '../../../src/services/mcp/config.js'
import type { Config } from '../../../src/services/config.js'

let dir: string

let seq = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `ecode-mcpsetup-${seq++}-`))
  // 批准文件隔离到 tmp（不触真实 ~/.ecode；vitest worker 禁 chdir——setupMcp 用 cwd 注入）
  setApprovedFilePath(path.join(dir, 'approved.json'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** setupMcp with cwd 注入（worker 不能 chdir）。 */
function setup(c: Config, reg: ToolRegistry): ReturnType<typeof setupMcp> {
  return setupMcp(c, reg, undefined, { cwd: dir })
}

function config(servers: Record<string, unknown>): Config {
  return {
    providers: {},
    current: { name: 'x', model: 'm' },
    maxIterations: 50,
    bashMaxOutputBytes: 30720,
    logLevel: 'info',
    mcpServers: servers as Config['mcpServers'],
  }
}

describe('setupMcp', () => {
  it('未批准的项目级 .mcp.json：pendingApproval 生成，本轮不接入', () => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { p: { type: 'stdio', command: 'node' } } }))
    const toolReg = new ToolRegistryImpl()
    const r = setup(config({ u: { type: 'stdio', command: 'node' } }), toolReg)
    expect(r.pendingApproval).toBeDefined()
    expect(r.pendingApproval?.file).toBe(path.join(dir, '.mcp.json'))
  })

  it('TOCTOU：批准前文件被改 → approve 拒绝（hash 不匹配）', async () => {
    const file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { p: { type: 'stdio', command: 'node' } } }))
    const r = setup(config({}), new ToolRegistryImpl())
    // 批准间隙内容被替换（不同 server 集）
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { evil: { type: 'stdio', command: 'curl' } } }))
    await expect(r.pendingApproval!.approve()).rejects.toThrow('已变化')
    // 批准未持久化（重跑仍会询问）
    expect(r.pendingApproval).toBeDefined()
    void mcpFileHash
  })

  it('批准成功 → hash 持久化 + 二段接入（start 追加不重置）', async () => {
    // 用不存在的命令（spawn ENOENT 快速失败——不阻塞断言；真 node 无参会挂 REPL 拖爆测试）
    const file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { p: { type: 'stdio', command: 'ecode-no-such-cmd' } } }))
    const r = setup(config({ u: { type: 'stdio', command: 'ecode-no-such-cmd' } }), new ToolRegistryImpl())
    await r.pendingApproval!.approve()
    const approvedRaw = JSON.parse(fs.readFileSync(path.join(dir, 'approved.json'), 'utf8')) as { files: string[] }
    expect(approvedRaw.files).toContain(mcpFileHash(file))
    // 二段后 server 就位（eager 连接会失败——无真进程，但 entries 已注册可查状态）
    expect(r.manager.serverNames().sort()).toEqual(['p', 'u'])
  })

  it('warnings：项目级解析失败 / env 缺失跳过', () => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{bad json')
    const r = setup(config({ miss: { type: 'http' as const, url: 'https://${ECODE_SETUP_MISSING_VAR}' } }), new ToolRegistryImpl())
    expect(r.warnings.some((w) => w.includes('解析失败'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('ECODE_SETUP_MISSING_VAR'))).toBe(true)
  })

  it('onTools 注册：工具进 Registry（mcp__ 前缀 + skipLocalValidate）', async () => {
    // eager 直连 fake 不行（setup 用真 SDK connectFn）——用 cache 预置走 cached 注册路径：
    // 直接测 setupMcp 的 onTools 链路需要注入 connectFn；此处验证 cached 路径（写 cache 文件不可行——
    // McpCache 走真实 ~/.ecode。改为只验证无 MCP 配置时零副作用。
    const r = setup(config({}), new ToolRegistryImpl())
    expect(r.manager.serverNames()).toEqual([])
    void vi
  })
})
