/**
 * Subagent：task 工具（M11-P2，方案 §1-§2）。
 *
 * task 是普通工具（readonly:true——并行池并发+免确认），execute 内嵌 runLoop：
 * 子代理全新 messages（prompt 为首条 user），跑完取最后 assistant 文本回父循环。
 *
 * 隔离四件（方案 §1.5 optsB 总表）：
 *   - 裁剪 Registry 现取现建（排除 task/ask_user/todo——递归物理封顶+交互权/清单主权归主）
 *   - NoopHistoryStore（不碰主会话 JSONL）+ transcript 独立落 ~/.ecode/agents/<agentId>.jsonl
 *   - 独立压缩链（独立 orchestrator：熔断计数不与父互扰；CONTEXT_TOO_LONG catch 双保险）
 *   - afterTools 由装配方注入剥离 autoCommit 的版本（quality 回喂进子 messages，提交只归父轮末）
 *
 * confirm 走 deps.confirm——装配方必须传串行队列包装后的父回调（方案 §1.3）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runLoop, type LoopRunOptions } from '../core/loop.js'
import type { HistoryLine, ToolUseBlock } from '../core/types.js'
import type { LLMProvider, ProviderReq } from '../providers/interface.js'
import type { Tool, ToolContext, ToolRegistry } from '../tools/interface.js'
import type { Logger } from './logger.js'
import { NoopHistoryStore } from './history.js'
import { CompactionOrchestrator } from './compaction/orchestrator.js'
import { SummarizeStrategy } from './compaction/summarize.js'
import { makeOnBeforeRequest } from './compaction/hook.js'
import type { Sandbox } from './sandbox.js'

/** 子代理默认迭代上限（方案 D6：钳 min(父,25) 的常数半边；跑飞防御） */
const SUB_MAX_ITERATIONS = 25
/** 单子代理硬超时（方案 D6：execute 自实现——task 未声明 timeout_ms，loop 层软超时对内嵌 runLoop 不适用） */
const SUB_TIMEOUT_MS = 10 * 60_000
/** 返回结论截断（方案 D12；CC 100k 太宽） */
const RESULT_MAX_BYTES = 16 * 1024
/** 子代理禁配清单（D3/D4/D20：递归封顶 + 交互权归主 + 清单主权归主） */
const EXCLUDED_TOOLS = new Set(['task', 'ask_user', 'todo'])

export interface SubagentDeps {
  getProviderReq(): ProviderReq
  getProvider(): LLMProvider
  logger: Logger
  /** 子代理 afterTools 构造器（剥离 autoCommit 的 quality 版）；null = 未启用质量回喂 */
  makeAfterTools: () => NonNullable<LoopRunOptions['afterTools']> | null
  /** 父 onBeforeWrite（checkpoint 快照 + editedFilesRef 归主——提交只归父轮末） */
  onBeforeWrite: (paths: string[], tool: string, toolUseId?: string) => Promise<void>
  sandbox?: Sandbox
  cwd: string
  /** 主 Registry（裁剪现取：含 MCP/plugin 运行期注册的工具） */
  registry: ToolRegistry
  /** 子 system 的项目级 ECODE.md 段（装配方算好注入；子代理骨架另拼） */
  projectInstructions: string
  /** 当前模型名（视觉守卫等 toolCtx.model；缺省不传） */
  getModel?: () => string
}

// —— UI 桥（confirm/warn/usage 三合一）：cli 装配工具、TuiApp 挂回调（setPermissionAsker 同款）。
// confirm 缺省 false（argv/未挂载 fail-closed——子代理副作用无 UI 即拒）；warn/usage 缺省丢弃。
export interface SubagentBridge {
  /** 父 confirm——TuiApp 必须挂串行队列包装版（makeConfirmQueue，方案 §1.3） */
  confirm: (use: ToolUseBlock) => Promise<boolean>
  warn?: (msg: string) => void
  usage?: (inputTokens: number, outputTokens: number, cache?: { read?: number; creation?: number }) => void
  /** 审阅 P0-2：写前钩子（TuiApp 版含 editedFilesRef 归主——父轮末 autoCommit 提交集；
   * cli deps 的 onBeforeWrite 只做快照，够不到 TuiApp 闭包，故必经桥） */
  onBeforeWrite?: (paths: string[], tool: string, toolUseId?: string) => Promise<void>
  /** 审阅 P1-1/P1-2：运行态 getter——TuiApp 挂（/model·/config 运行中切换、Tab 切沙箱档后
   * 子代理取新值；缺省回退 deps 静态值=argv 单次模式） */
  getProviderReq?: () => ProviderReq
  getProvider?: () => LLMProvider
  getSandbox?: () => import('./sandbox.js').Sandbox
  getModel?: () => string
}

let bridge: SubagentBridge | null = null

export function setSubagentBridge(b: SubagentBridge | null): void {
  bridge = b
}

function bridgeConfirm(use: ToolUseBlock): Promise<boolean> {
  return bridge !== null ? bridge.confirm(use) : Promise.resolve(false)
}

export type SubagentType = 'general' | 'explore'

// —— 进度桥（P4 UI 数据源；askUserBridge 同款模块级模式：cli 装配工具、TuiApp 挂 handler） ——
export interface SubagentStatus {
  id: string
  description: string
  /** 最近工具活动（折叠行动态段） */
  activity: string
}

const activeAgents = new Map<string, SubagentStatus>()
let progressHandler: ((list: SubagentStatus[]) => void) | null = null

/** TuiApp 挂载注入（卸载置 null）；每次状态变化推送全量快照 */
export function setSubagentProgressHandler(h: ((list: SubagentStatus[]) => void) | null): void {
  progressHandler = h
}

function notifyProgress(): void {
  progressHandler?.([...activeAgents.values()])
}

/** agentId：时间序短段 + 内容短哈希（随机源；双协议 use.id 前缀固定必撞号，且 execute 拿不到 use.id） */
function makeAgentId(): string {
  const t = Date.now().toString(36).slice(-5)
  const h = createHash('sha256').update(`${t}-${Math.random()}`).digest('hex').slice(0, 4)
  return `a-${t}${h}`
}

/** 子代理 system 骨架（方案 §2 两型；type=explore 叠加只读宣言）。 */
export function subagentSystem(type: SubagentType, projectInstructions: string): string {
  const base = `你是独立子任务代理，prompt 是你的全部背景，缺信息用工具自查不要猜。只做 prompt 说的事。
完成后只输出结论：结果/关键发现/产物路径三段——调用者只拿这段文字，过程细节不会被看到。
你不能向用户提问；有疑问就把不确定点写进结论。你不能派子任务。
通用准则：广搜窄读（先 grep/glob 圈范围再精读）；除非 prompt 明确要求，不新建文档文件（报告写在结论里）。`
  const readonly = type === 'explore'
    ? `\n你是只读调研代理：没有写类工具（尝试会失败）。返回的文件引用一律绝对路径。调研彻底度跟随 prompt 的指示（quick/medium/very thorough）。`
    : ''
  const proj = projectInstructions !== '' ? `\n\n## 项目规范（项目级 ECODE.md）\n${projectInstructions}` : ''
  return base + readonly + proj
}

/** 子代理 logger：全通道尾参注入 agentId（grep agentId 即该代理轨迹）。 */
export function makeAgentLogger(base: Logger, agentId: string): Logger {
  return {
    debug: (c, e, p, i) => base.debug(c, e, p, i, agentId),
    info: (c, e, p, i) => base.info(c, e, p, i, agentId),
    warn: (c, e, p, i) => base.warn(c, e, p, i, agentId),
    error: (c, e, p, i) => base.error(c, e, p, i, agentId),
  }
}

/**
 * 裁剪 Registry：父表的**过滤视图**（审阅 P1-3——不是重注册裸工具的复制表）：
 * get 走父 registry（HookedToolRegistry.get 返回 hook 包装版——子代理工具调用过
 * PreToolUse/PostToolUse/权限门，与主循环一致）；禁配名单物理不可见（递归封顶）；
 * MCP/plugin 运行期注册天然现取（视图无快照漂移）。
 */
export class SubRegistry implements ToolRegistry {
  constructor(
    private readonly parent: ToolRegistry,
    private readonly type: SubagentType,
  ) {}

  register(): void {
    // 视图只读——子代理不引入新工具
  }
  unregister(): void {
    // 同上
  }
  get(name: string): Tool | undefined {
    if (EXCLUDED_TOOLS.has(name)) return undefined
    const t = this.parent.get(name)
    if (t === undefined) return undefined
    if (this.type === 'explore' && !t.readonly) return undefined
    return t
  }
  specs(): ReturnType<ToolRegistry['specs']> {
    return this.list().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  }
  list(): Tool[] {
    return this.parent
      .list()
      .filter((t) => !EXCLUDED_TOOLS.has(t.name) && (this.type !== 'explore' || t.readonly))
  }
  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string } {
    if (EXCLUDED_TOOLS.has(name)) return { ok: false, error: `工具 ${name} 对子代理不可用` }
    return this.parent.validate(name, input)
  }
}

/** 兼容旧测试入口（视图别名）。 */
export function buildSubRegistry(parent: ToolRegistry, type: SubagentType): ToolRegistry {
  return new SubRegistry(parent, type)
}

/** optsB 构造（方案 §1.5 总表）。导出供单测断言隔离面。 */
export function makeSubagentOpts(
  deps: SubagentDeps,
  agentId: string,
  description: string,
  type: SubagentType,
  signal: AbortSignal,
): LoopRunOptions {
  // 审阅 P1-1/P1-2：桥 getter 优先（TuiApp 运行态：/model 切换、Tab 切沙箱档后取新值）；
  // 构造时取一次=子代理生命周期内配置快照（中途切换影响下一批，优于 cli 静态闭包的永远旧值）
  const providerReq = bridge?.getProviderReq !== undefined ? bridge.getProviderReq() : deps.getProviderReq()
  const provider = bridge?.getProvider !== undefined ? bridge.getProvider() : deps.getProvider()
  const system = subagentSystem(type, deps.projectInstructions)
  const tools = buildSubRegistry(deps.registry, type)
  // 独立压缩链：boundary 只进子内存 messages（NoopHistory 不落盘，onCompacted 不配——无 UI 可重建）
  const orchestrator = new CompactionOrchestrator()
  orchestrator.register(new SummarizeStrategy())
  const onBeforeRequest = makeOnBeforeRequest(orchestrator, provider, providerReq, system, {
    history: new NoopHistoryStore(),
    signal,
    tools: tools.specs(),
    onCompacted: async () => {}, // no-op：子代理无 committed 重建（boundary 在内存 messages 存活）
  })
  return {
    provider,
    tools,
    logger: makeAgentLogger(deps.logger, agentId),
    history: new NoopHistoryStore(),
    callbacks: {
      // 进度缓冲与 UI 转发——绝不 setActive（不与父抢渲染）；onActivity/onIter 不配
      onText: () => {},
      onToolStart: (name) => {
        const st = activeAgents.get(agentId)
        if (st !== undefined) {
          st.activity = name
          notifyProgress()
        }
      },
      onUsage: (i, o, c) => bridge?.usage?.(i, o, c),
      onWarn: (m) => bridge?.warn?.(`「${description}」${m}`),
    },
    providerReq,
    system,
    maxIterations: SUB_MAX_ITERATIONS,
    toolCtx: {
      cwd: deps.cwd,
      signal,
      onBeforeWrite: bridge?.onBeforeWrite ?? deps.onBeforeWrite,
      ...((bridge?.getSandbox !== undefined ? bridge.getSandbox() : deps.sandbox) !== undefined
        ? { sandbox: bridge?.getSandbox !== undefined ? bridge.getSandbox() : deps.sandbox }
        : {}),
      ...((bridge?.getModel?.() ?? deps.getModel?.()) !== undefined
        ? { model: bridge?.getModel?.() ?? deps.getModel?.() }
        : {}),
    },
    confirm: bridgeConfirm,
    signal,
    onBeforeRequest,
    afterTools: deps.makeAfterTools() ?? undefined,
  }
}

/** 取子 messages 中最后一条含 text 的 assistant 文本（返回契约）。 */
function lastAssistantText(messages: HistoryLine[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if ('role' in m && m.role === 'assistant') {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j]
        if (b.type === 'text' && b.text !== '') return b.text
      }
    }
  }
  return ''
}

/** 结论 16k 截断（字节界，尾部标注）。 */
function clampResult(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= RESULT_MAX_BYTES) return text
  return `${buf.subarray(0, RESULT_MAX_BYTES).toString('utf8')}…（结论超 16k 已截断；完整过程见 transcript）`
}

/**
 * task 工具工厂（方案 §1.2：装配期创建——deps 全 getter/引用，静态 import 动态值必 stale）。
 * readonly:true → executeTools 并行池天然并发 + 免确认（副作用确认由子循环 confirm 把守）。
 */
export function makeTaskTool(deps: SubagentDeps): Tool {
  return {
    name: 'task',
    description: `把独立的子任务委派给并发子代理。子代理看不到当前对话，prompt 必须自包含。

何时用：大范围搜索/多文件调研归纳/互相独立的并行子任务/不需要过程细节只要结论的工作。
何时不用（直接自己做更快更准）：读指定文件、找特定定义、2-3 个文件内的小改动、需要当前对话上下文的任务。

写 prompt 像给刚进门的同事 briefing：目标与原因、涉及文件/目录、验收标准、期望返回格式。
禁止"根据你的发现修 bug"这类委派理解的写法——写清文件路径与具体要改什么。
明确告知是写代码还是只调研。并行任务给不同子代理时，让它们碰不同的文件。

注意：本工具阻塞至子代理返回结论，无 task_id/task_output 轮询——那是 bash run_in_background 后台命令的机制。`,
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-5 词任务摘要（进度行与告警前缀用）' },
        prompt: { type: 'string', description: '任务书：目标与原因/涉及文件/验收标准/期望返回格式（自包含）' },
        type: { type: 'string', description: 'general（默认，全能）| explore（只读调研）' },
      },
      required: ['description', 'prompt'],
    },
    readonly: true,
    async execute(args, ctx: ToolContext) {
      const { description, prompt } = args as { description: string; prompt: string; type?: string }
      const type: SubagentType = (args as { type?: string }).type === 'explore' ? 'explore' : 'general'
      const agentId = makeAgentId()
      activeAgents.set(agentId, { id: agentId, description, activity: '启动中' })
      notifyProgress()
      // 硬超时与用户中断取或（Node 20+ AbortSignal.any）
      const timeout = AbortSignal.timeout(SUB_TIMEOUT_MS)
      const signal = AbortSignal.any([ctx.signal, timeout])
      const opts = makeSubagentOpts(deps, agentId, description, type, signal)
      const messages: HistoryLine[] = []
      try {
        await runLoop(messages, prompt, opts)
        const text = lastAssistantText(messages)
        if (text === '') {
          return {
            content: `子代理未产出文本结论（可能被中断或超时）。完整过程：~/.ecode/agents/${agentId}.jsonl`,
            is_error: true,
          }
        }
        return { content: `${clampResult(text)}
（完整过程：~/.ecode/agents/${agentId}.jsonl）` }
      } catch (e) {
        // 双保险之一：子代理超窗/致命错误不上抛炸父循环（独立压缩链是第一道）
        const msg = e instanceof Error ? e.message : String(e)
        return {
          content: `子代理失败：${msg}${msg.includes('CONTEXT') || msg.includes('上下文') ? '——任务过大，建议拆分' : ''}。完整过程：~/.ecode/agents/${agentId}.jsonl`,
          is_error: true,
        }
      } finally {
        activeAgents.delete(agentId)
        notifyProgress()
        // transcript 全量落盘（abort/超时路径也落；callbacks 逐条写缺入参与轮次边界——方案 P2-3）
        // 异步 IO（P2 修复：execute 在主循环事件循环上跑，同步 mkdir/write 冻结渲染）；
        // 0700：transcript 含任务原文，目录不给同机其他账户读
        try {
          const dir = join(homedir(), '.ecode', 'agents')
          await mkdir(dir, { recursive: true, mode: 0o700 })
          await writeFile(join(dir, `${agentId}.jsonl`), messages.map((m) => JSON.stringify(m)).join('\n'), 'utf8')
        } catch (e) {
          // 落盘失败不掩盖主结果（transcript 是辅助通道），但留日志可排查（不空吞；
          // category 用 'tool'——LogCategory 无 subagent 专属类目，此处属 task 工具执行期 IO）
          deps.logger.warn('tool', 'subagent_transcript_write_failed', {
            agentId,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }
    },
  }
}
