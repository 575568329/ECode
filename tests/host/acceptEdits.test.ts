/**
 * 界面批 C1：accept-edits 档宿主侧放行语义（hostConfirm 层）。
 * - 纯编辑类（edit_file/write_file 副作用）免审批：不产生 approval/requested、轮直通
 * - bash/其他副作用仍走审批（fail-closed：无订阅者时挂起等待——此处验 requested 已发）
 * - 敏感路径编辑照卡（.env 等 isSensitivePath 命中 → 照常弹审批）
 */

import { describe, it, expect } from 'vitest'
import { HostSession, type HostDeps } from '../../src/host/session.js'
import { ToolRegistryImpl } from '../../src/tools/registry.js'
import type { Tool } from '../../src/tools/interface.js'
import type { LLMProvider, LLMProviderRunRequest } from '../../src/providers/interface.js'
import type { Delta } from '../../src/core/types.js'
import type { Logger } from '../../src/services/logger.js'
import { NoopHistoryStore } from '../../src/services/history.js'
import { CompactionOrchestrator } from '../../src/services/compaction/orchestrator.js'
import { SummarizeStrategy } from '../../src/services/compaction/summarize.js'
import { emptyShellConfig, type Config } from '../../src/services/config.js'
import type { ProtocolEvent } from '../src/../src/protocol/types.js'

class ScriptProvider implements LLMProvider {
  readonly type = 'mock'
  private call = 0
  constructor(private readonly script: Delta[][]) {}
  async *run(_req: LLMProviderRunRequest): AsyncIterable<Delta> {
    const deltas = this.script[this.call++] ?? [{ type: 'done', stop_reason: 'end' }]
    for (const d of deltas) yield d
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const mkEditTool = (name: string, path: string): Tool => ({
  name,
  description: name,
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
    required: ['path', 'oldString', 'newString'],
  },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
  _pathForTest: path,
})

const mkWriteEnvTool = (): Tool => ({
  name: 'write_file',
  description: 'w',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
})

const mkBashTool = (): Tool => ({
  name: 'bash',
  description: 'bash',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  readonly: false,
  async execute() {
    return { content: 'ok' }
  },
})

function makeHost(script: Delta[][], tools: Tool[], defaultMode: 'accept-edits' | 'default'): HostSession {
  const reg = new ToolRegistryImpl()
  for (const t of tools) reg.register(t)
  const orch = new CompactionOrchestrator()
  orch.register(new SummarizeStrategy())
  const config: Config = {
    ...emptyShellConfig(),
    providers: { m: { type: 'mock', baseURL: 'http://x', apiKey: 'sk', models: ['m'], contextWindow: 32000 } },
    current: { name: 'm', model: 'm' },
    maxIterations: 40,
    sandbox: { ...emptyShellConfig().sandbox, defaultMode },
  }
  return new HostSession({
    providerRegistry: { getByType: () => new ScriptProvider(script) } as HostDeps['providerRegistry'],
    tools: reg,
    logger: noopLogger,
    history: new NoopHistoryStore(),
    getConfig: () => config,
    orchestrator: orch,
    skillListForPrompt: () => [],
  })
}

const collect = (host: HostSession): ProtocolEvent[] => {
  const evs: ProtocolEvent[] = []
  host.subscribe((ev) => evs.push(ev))
  return evs
}

describe('C1 accept-edits：hostConfirm 放行语义', () => {
  it('edit_file 免审批直放（无 approval/requested、轮完成）', async () => {
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 'e1', name: 'edit_file' },
        { type: 'tool_use_delta', id: 'e1', partial_json: '{"path":"src/a.ts","oldString":"a","newString":"b"}' },
        { type: 'tool_use_end', id: 'e1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'done', stop_reason: 'end' }],
    ]
    const host = makeHost(script, [mkEditTool('edit_file', 'src/a.ts')], 'accept-edits')
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    await host.whenIdle()
    expect(evs.some((e) => e.type === 'turn/completed')).toBe(true)
    expect(evs.some((e) => e.type === 'approval/requested' && e.tool === 'edit_file')).toBe(false)
  })

  it('bash 仍走审批（approval/requested 已发）', async () => {
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 'b1', name: 'bash' },
        { type: 'tool_use_delta', id: 'b1', partial_json: '{"command":"ls"}' },
        { type: 'tool_use_end', id: 'b1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ]
    const host = makeHost(script, [mkBashTool()], 'accept-edits')
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    // 审批挂起中（无订阅者可答 → fail-closed 等待）；requested 事件已出现即证仍走审批
    for (let i = 0; i < 40 && !evs.some((e) => e.type === 'approval/requested'); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(evs.some((e) => e.type === 'approval/requested' && e.tool === 'bash')).toBe(true)
    host.dispose()
  })

  it('敏感路径编辑照卡（.env 命中 isSensitivePath → 仍弹审批）', async () => {
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 's1', name: 'write_file' },
        { type: 'tool_use_delta', id: 's1', partial_json: '{"path":".env.local","content":"x"}' },
        { type: 'tool_use_end', id: 's1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ]
    const host = makeHost(script, [mkWriteEnvTool()], 'accept-edits')
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    for (let i = 0; i < 40 && !evs.some((e) => e.type === 'approval/requested'); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(evs.some((e) => e.type === 'approval/requested' && e.tool === 'write_file')).toBe(true)
    host.dispose()
  })

  // —— 清账批 III P0-1：项目级 .ecode/settings*.json（权限自授权链）照卡 ——
  const mkWriteTool = (): Tool => mkWriteEnvTool() // 同 schema（path+content）

  const runAndWaitApproval = async (pathJson: string): Promise<{ evs: ProtocolEvent[]; host: HostSession }> => {
    const script: Delta[][] = [
      [
        { type: 'tool_use_start', id: 'p1', name: 'write_file' },
        { type: 'tool_use_delta', id: 'p1', partial_json: `{"path":${JSON.stringify(pathJson)},"content":"x"}` },
        { type: 'tool_use_end', id: 'p1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
    ]
    const host = makeHost(script, [mkWriteTool()], 'accept-edits')
    const evs = collect(host)
    await host.send({ op: 'prompt', text: 'go', mode: 'StartOrSteer' })
    for (let i = 0; i < 40 && !evs.some((e) => e.type === 'approval/requested') && !evs.some((e) => e.type === 'turn/completed'); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    return { evs, host }
  }

  it('P0-1：cwd 内 .ecode/settings.local.json 仍弹审批（hook 自授权链堵漏）', async () => {
    const { evs, host } = await runAndWaitApproval('.ecode/settings.local.json')
    expect(evs.some((e) => e.type === 'approval/requested' && e.tool === 'write_file')).toBe(true)
    host.dispose()
  })

  it('P0-1：cwd 内 .ecode/settings.json 同样照卡', async () => {
    const { evs, host } = await runAndWaitApproval('.ecode/settings.json')
    expect(evs.some((e) => e.type === 'approval/requested' && e.tool === 'write_file')).toBe(true)
    host.dispose()
  })

  it('P0-1 对照：myapp/settings.json（非 .ecode 目录）直放不弹审批', async () => {
    const { evs, host } = await runAndWaitApproval('myapp/settings.json')
    expect(evs.some((e) => e.type === 'approval/requested')).toBe(false)
    expect(evs.some((e) => e.type === 'turn/completed')).toBe(true)
    host.dispose()
  })

  it('P0-1 对照：src/x.ts 普通文件直放不弹审批', async () => {
    const { evs, host } = await runAndWaitApproval('src/x.ts')
    expect(evs.some((e) => e.type === 'approval/requested')).toBe(false)
    expect(evs.some((e) => e.type === 'turn/completed')).toBe(true)
    host.dispose()
  })
})
