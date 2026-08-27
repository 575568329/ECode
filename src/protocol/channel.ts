/**
 * M12 协议通道（B0，方案 §3.2）：ClientTransport 抽象 + 阶段 1 同进程实现。
 *
 * 分工：宿主侧 bind(命令分发器)+publish(事件广播、分配 seq)；客户端侧 send/subscribe。
 * 阶段 2（B7）新增 HttpTransport 实现同一接口（fetch + SSE），TuiApp 换管道零改动——
 * 这是 opencode TuiInput 抽象（packages/tui/src/app.tsx:142）的等价物。
 */

import type { CommandResult, ProtocolCommand, ProtocolEvent, PublishableEvent } from './types.js'

export type EventHandler = (ev: ProtocolEvent) => void
export type CommandDispatcher = (cmd: ProtocolCommand) => Promise<CommandResult>

/** 订阅者能力声明（M14-C2⑧）：canAnswer=false 的订阅只看不应答（mux 观察型连接），
 *  不计入审批 fail-closed 判定——否则任一常开仪表盘就破坏 sensitive 门的 fail-fast。 */
export interface SubscribeOptions {
  canAnswer?: boolean
}

/** 客户端侧统一数据访问面（TuiApp/Web/手机共契约） */
export interface ClientTransport {
  send(cmd: ProtocolCommand): Promise<CommandResult>
  /** 订阅事件流，返回退订函数（多订阅者 fan-out） */
  subscribe(handler: EventHandler): () => void
  dispose(): void
}

/**
 * 同进程直连通道（阶段 1）。协议语义不因同进程打折（铁律：进程内不绕）：
 * - 事件帧是深快照（structuredClone——「纯数据、不共享对象引用」机械成立）
 * - 命令经分发器异步回执，错误收敛为 ok:false（不向客户端 throw）
 */
export class InMemoryChannel implements ClientTransport {
  private seq = 0
  private readonly handlers = new Set<EventHandler>()
  private readonly passiveHandlers = new Set<EventHandler>()
  private dispatcher: CommandDispatcher | null = null
  private disposed = false

  /** 宿主侧：绑定命令分发器（HostSession 构造时，B1） */
  bind(dispatcher: CommandDispatcher): void {
    this.dispatcher = dispatcher
  }

  /** 宿主侧：广播事件并分配会话级单调 seq（顺序/去重/游标三用的唯一来源）。
   *  structuredClone：帧即快照（发布后源对象变更不影响已发帧；与 B7 HTTP 形态的
   *  wire 序列化语义一致），且机械禁止函数/类引用进入协议（clone 直接抛错）。 */
  publish(ev: PublishableEvent): ProtocolEvent {
    const full = { ...structuredClone(ev), seq: ++this.seq } as ProtocolEvent
    if (!this.disposed) {
      for (const h of this.handlers) h(full)
      for (const h of this.passiveHandlers) h(full)
    }
    return full
  }

  /** 宿主侧：当前已分配到的 seq（订阅基线/历史分页游标用，B2/B5 消费） */
  get lastSeq(): number {
    return this.seq
  }

  /** 可应答订阅者数（B2 审批 fail-closed 判定：零可应答者=无应答渠道；
   *  M14-C2⑧：passive（canAnswer=false）订阅不计入——观察型连接不撑起 sensitive 门） */
  get subscriberCount(): number {
    return this.handlers.size
  }

  send(cmd: ProtocolCommand): Promise<CommandResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, error: '通道已销毁', code: 'DISPOSED' })
    }
    if (this.dispatcher === null) {
      return Promise.resolve({ ok: false, error: '命令分发器未绑定', code: 'NO_DISPATCHER' })
    }
    // dispatcher 自身异常兜底为回执（宿主不 throw 到客户端——协议纪律）
    return this.dispatcher(cmd).catch((e: unknown): CommandResult => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: 'DISPATCH_ERROR',
    }))
  }

  subscribe(handler: EventHandler, opts: SubscribeOptions = {}): () => void {
    const passive = opts.canAnswer === false
    const set = passive ? this.passiveHandlers : this.handlers
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  dispose(): void {
    this.disposed = true
    this.handlers.clear()
    this.passiveHandlers.clear()
  }
}
