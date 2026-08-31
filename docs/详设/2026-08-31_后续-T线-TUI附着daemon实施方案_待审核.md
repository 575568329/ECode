# M14 T 线（TUI 附着 daemon：同会话双客户端）实施方案

> 状态：**已拍板（v1.2，2026-08-31 用户拍板 D-T1~T8），实施中**——四角色审阅修复吸收：架构/资深开发/安全/测试四席，报告见 `docs/解析/2026-08-31_T线方案四角色审阅_已完成.md`
> 定调（2026-08-31 用户拍板）：**TUI 的内容在手机上也能继续操作，跟本地操作一样**——TUI 会话归常驻 daemon 托管，电脑 TUI 与手机 Web 是同一会话的两个客户端；daemon detached 常驻；连不上 daemon 降级回同进程直连（Embedded 保留）；**立即实施，插队于 R1 配对之前**（原「R 线整体置 M15 前」排期由本线插入，其余不变）。
> 前置：M14 V+C 线全部完成（`9d95fd7`→`7f8af5a`）；本线是「异地手机控制」需求拆出的第一环——没有它，R1/R2 中继修通后手机连上的只是空 daemon（TUI 会话全不在）。

## 1. 背景与目标

现状断链：`ecode`（TUI）在进程内自建宿主（`src/cli/index.ts:242` makeDeps 直连 InMemoryChannel），`ecode serve` 是另一进程另一套宿主。后果：TUI 正跑任务时人离开，手机 Web 只能看到 sessions 共享目录的文件级滞后历史——**看不到实时流、不能插话、不能审批**；TUI 关闭即进程亡、任务死。`ecode serve` 形态的会话虽然 web/飞书可异地操作，但用户主力是 TUI 直跑。

目标形态（codex `AppServerTarget` 同构的三态）：

```
[现状 Embedded]        ecode 进程 ── InMemoryChannel ── 宿主（同进程）          ← 保留为降级态
[T 线 LocalDaemon]     ecode(TUI) ── MultiTransport(multi 信封, HTTP+SSE) ──┐
                       ecode serve(daemon, detached 常驻) ──────────────────┘ 同一批宿主
                       web/手机/PWA ────────────────────────────────────────┘ 同一会话双客户端
[R 线 Remote relay]    daemon ──出站 WS── relay ──密文── 异地客户端              ← R1-R3 接续
```

**目标体验**：TUI 发起任务 → 关掉 TUI 人走 → 任务在 daemon 里继续跑 → 手机打开 Web 看到同一条会话的实时流，可插话/中断/点审批 → 电脑 TUI 同帧显示 → 回家重开 TUI 附着同一会话接着聊。

**非目标**：
- 不做终端画面投屏（远程操控 PTY 字节流是另一条路——orca 的 terminal input floor 模型为此设计；ECode 是结构化会话协议，不需要）；
- 不做开机自启/托盘（记后续增强，见 §8 附带记录）；
- 不改 R 线范围（配对/中继/E2EE 仍按 R 方案 §5-§7）。

## 2. 三路源码调研结论（2026-08-31）

### 2.1 codex（最直接的同类实现——目标形态现成参考）

- **三态连接拓扑**：TUI 的 `AppServerTarget::{Embedded, LocalDaemon, Remote}`（`codex-rs/tui/src/lib.rs:276-280`）——Embedded 进程内嵌 app-server（默认）；LocalDaemon 探测本机 daemon socket 存在即附着，仅 50ms 超时，失败退回 Embedded（`lib.rs:240-241,445-470,855-875`）；Remote 连 ws:// 远端。**与 ECode「现状→T 线→R 线」三阶段完全同构**。
- **resume 即 attach**：对已运行 thread 发 `thread/resume` = 「历史快照 + 原子订阅后续更新」一次交付（`app-server/src/thread_state.rs:64-66`、`thread_processor.rs:3940`）；带 history 的 resume 撞上运行中线程直接报错防旧历史覆盖活线程；断连按 connection 清理订阅。
- **多前端同会话是一等能力**：一个 thread 多个 connection 订阅，事件按订阅者列表广播（`thread_state.rs:393-400`）。
- **跨进程恢复真相源 = rollout JSONL 全量重放**：内存态（订阅/审批/挂起 turn）不跨进程保留（`core/src/thread_manager.rs:974-1011`）。CC 同构：转录清洗重建、未完成 tool_use 直接剔除（claude-code-main `src/utils/messages.ts:2795-2840`）。
- **daemon 生命周期件**：PID 文件+lock+LifecycleCommand{Start,Restart,Stop}（`app-server-daemon/src/lib.rs:41-60`）。

### 2.2 opencode v2（daemon 发现/常驻/审批仲裁的完整蓝本）

- **发现协议**：state 目录 `server.json` 存 `{id,version,url,pid}`；复用前必须过 `/health`（2s 超时）+ 版本一致；tmp+rename 原子写 0600（`packages/cli/src/services/daemon.ts:39-78,164-173`）；server 每 10s 校验注册仍是自己、被抢占即自杀（单实例仲裁）；stop 先鉴权再 SIGTERM→轮询→SIGKILL 防杀错 PID。
- **常驻形态**：默认命令 `daemon.transport()` 确保 server 在跑再进 TUI；`spawn(detached).unref()` 拉起的 server **不随 TUI 退出而死**；`opencode service start/stop/status` 显式管理；**无空闲退出**。
- **TUI 数据面成色**：几乎全走 HTTP/SSE；混合面 = 审批 auto-approve 是客户端行为、斜杠命令本地匹配后调 `session.command`、TUI 本地偏好文件不经 server。
- **会话选中态归属**：纯客户端本地 state，server 无共享「当前会话」概念；A 切换 B 不跟。
- **插话仲裁**：prompt 提交是持久化 admission（per-session 单调 seq + 幂等 id），执行由 per-session 串行 coordinator 驱动，忙时 join 当前执行而非并发跑。
- **审批**：server 权威 pending 队列，任何客户端可应答，first-reply-wins，`permission.replied` 广播收敛；reject 级联拒同 session 全部 pending。
- **勿踩的坑**：① `tui.*` 定向事件无 per-client 寻址——两个 TUI attach 同 server 时互相跟跳；② SSE 无游标+全量广播+dropping 缓冲，慢客户端溢出静默丢帧；③ 版本不匹配杀旧 server 重建——升级后重开 TUI 杀死跑着的任务；④ v1/v2 双事件端点过渡债务。

### 2.3 orca（常驻进程生命周期与重放语义）

- **一个 dispatcher N 种传输**：桌面 IPC、CLI socket、手机 E2EE WS 全连同一 `RpcDispatcher`；renderer 同一 React 应用+可替换 preload 层（桌面=Electron IPC，Web=E2EE WS）。
- **共享/隔离划分**：共享态（server 权威+变更广播）vs 导航/选中态（per-client 隔离，有专门集成测试）。
- **生命周期三层**：RPC server 随 Electron main 进程死；终端 PTY 由独立 detached daemon 承载、正常退出只 disconnect 不杀（warm reattach）；daemon 空闲自退出+adoption 超时。
- **重放**：服务端定长缓冲+单调 seq+**epoch**（重启后 seq 归零，epoch 不匹配→全量返回，杜绝 watermark 静默卡死）；订阅防漏=listener-first 快照；重连=全量快照+帧 seq 丢旧，不做字节游标。
- **勿踩的坑**：① 非流式通道上做流式订阅最终长出第二套事件信封；② 常驻进程不预定义「谁杀它/何时保活」会同时遭受空闲僵尸和假活两类故障；③ 安全默认=绑 loopback、显式动作才扩 0.0.0.0 且失败回滚。

### 2.4 其他

- **Claude Code**：单进程自包含实证（全 `src/` 无 agent server 监听）；多端靠云端 bridge（REPL 单 worker + 消息流镜像）——非本地多客户端路线，不取。
- **勘误**：`D:\study\harness` 是 Gitness（CI 平台），与此前调研记录中的「harness 七动词/resolver/审批三层」无关——后者实指 deepseek-harness（`D:\study\deepseek-harness`）。已有记忆条目待更正。

### 2.5 对齐结论

| 设计面 | 采纳 | 来源 |
|---|---|---|
| 三态连接（Embedded/LocalDaemon/Remote） | TuiApp 只面向 ClientTransport，形态差异收敛在装配层注入的 transport 实现 | codex §2.1 |
| daemon 发现：注册文件+健康探测+版本校验+原子写 | ECode 已有 server.json 0600+id+防脑裂 watchdog（`serveMain.ts:241-256`，10s 注册校验**已存在**），补探活探测/version schema/原子写/拉起锁四件 | opencode §2.2 |
| detached+unref 常驻、无空闲退出 + stdio 显式 ignore + windowsHide | 用户拍板常驻；**spawn 细节见 §4.1（v1.1 修：防 Windows 弹窗与 EPIPE 杀 daemon）** | opencode §2.2 + 架构席 P0-1 |
| resume 即 attach（历史快照+原子订阅一次交付）；「当前会话」per-client | 附着语义基线 | codex §2.1 + opencode §2.2 |
| 插话/审批权威态在宿主、多客户端广播收敛 | ECode 已具备（审批 claim+TTL、mux 广播、插话串行队列），零改动直接受益 | opencode §2.2（ECode 前置更细：claim 比 first-reply-wins 多一层认领语义） |
| per-client 寻址/过滤从第一天就做 | 事件**全量收+客户端按 sessionId 本地过滤**（web 现行模式，切会话零重连）；不做连接级 sessionId 订阅参数（web 端该参数已废弃被有意忽略） | opencode 坑①②反面 + orca 隔离划分 |
| 断线恢复：seq 游标+gap 全量补同步（W-9 已有服务端+web 端） | TUI MultiTransport 实现同款游标跟踪（T4） | orca §2.3 + ECode W-9 |
| 版本不匹配：拒绝附着+提示（非杀旧重建） | 保住跑着的任务；流程图已按此修正（§4.1 v1.1） | opencode 坑③反面 |

## 3. ECode 现状接缝（2026-08-31 逐点核验，四席复核后修订）

### 3.1 已就位（零改动直接受益）

| 现状 | 位置 | T 线消费方式 |
|---|---|---|
| ClientTransport 抽象 + InMemoryChannel 同进程实现 | `src/protocol/channel.ts` | TUI 客户端面只依赖该接口；附着=装配层换 MultiTransport（T4 新写，**现 HttpTransport 是裸命令+已退役端点，连 multi 不通，不在此表**——v1.1 修） |
| 协议事件 32 枚举 | `src/protocol/types.ts:51-84` | TUI 渲染数据面全部有帧可依 |
| 协议命令宿主 dispatch 已接 **17** 个：prompt/interrupt/interjection.clear/approval.respond+claim/askUser.respond/askSelect.respond/session.{clear,restore,list,archive,rename,read}/item.read/model.set/config.get/sandbox.set（v1.1 修：原记 18） | `src/host/session.ts:569-768` | web 已全靠这些跑；TUI 直调点大半有等价命令 |
| session/new 信封层拦截 | `src/server/multi.ts:420-424` | 真新建不落会话承载 |
| mux 双客户端同帧验收（G2）+ mux 事件全量广播+客户端按 frame.sessionId 分发（web 现行） | `src/server/multi.ts`、`web/src/lib/connect.ts:49-50` | 双端同会话的广播基建现成；TUI 照抄 web 过滤模式 |
| 审批 claim+TTL+canAnswer fail-closed+pending 审批重放（mux 订阅即补发） | `src/host/approval.ts:41`、`src/host/session.ts:175-177` | 双端审批仲裁基建现成 |
| 插话串行队列+敏感卡宿主级串行化 | `src/host/session.ts`（M11/D9） | 双端同时插话的仲裁已有 |
| UserPromptSubmit 宿主 dispatch（**新轮路径 M12-B1 已落地**：block→systemMsg+不开轮、additionalContext→拼进 input） | `src/host/session.ts:817-833`（commit b652968） | v1.1 修：web 发消息触发 hook **现状已成立**；T1 hook 工作量见 §4.3 重写后的缺口清单 |
| serve 生命周期（stop/接管/watchdog 防脑裂/server.json 0600+id） | `src/cli/serveMain.ts` | daemon 常驻底座；接管语义需改造（§4.1，架构席 P0-2） |
| W-9 断线游标（mux `?sinceSeq=` 重放缓冲 500 帧+gap 帧语义） | `src/server/multi.ts:294-315`、`web/src/lib/connect.ts:62-72` | TUI MultiTransport 照抄 web 端游标跟踪（T4） |

### 3.2 死命令（协议已声明、宿主零实现、无人消费——T1 接线清单）

`rewind/list`、`rewind/exec`、`panel/data`、`config/patch`（web 无 config 面板、YAGNI 方向删除，随 D-T 拍板）、`command/exec`（已被 prompt 内斜杠分流取代——`session.ts:464-513` interceptSlashCommand，host 可执行白名单 help/stats/cost/clear/compact——直接从协议删除）。

### 3.3 TuiApp 直调面映射表（T2 改造清单；v1.1 按开发席复核重写——补 host.* 面、改 #14、fork 归位）

**A. `deps.*` UI 消费面**：

| # | 直调点（行号） | 现状协议等价 | T 线动作 |
|---|---|---|---|
| 1 | `deps.history.currentSessionId()` ×5（206/267/996/1274/1565） | —（客户端态） | 客户端本地缓存 sid（连接回执/restore 取） |
| 2 | `deps.history.loadAll(cwd)`（1690） | `session/list` ✓（metas 同源同形，`session.ts:668-671`） | 改走命令，**必须带 `includeArchived:true`**（TUI 现状列表含归档，session/list 默认滤——行为差，开发席 P1-4） |
| 3 | `deps.project.ensureRestore(sid).transcript`（982）/ `deps.history.restoreFull`（983） | `session/restore` + `session/read`（无参即全量，与 restoreFull 同源同形，`session.ts:705-706`） | 改走命令 |
| 4 | RewindPanel `store={deps.checkpoint}`（1564）消费 `list/detectExternalChanges/revert` 三方法（`RewindPanel.tsx:54-88`） | `rewind/list`+`rewind/exec` **死命令，且两 op 结构上喂不饱面板**（缺 detectExternalChanges 对应面与 `restored[]` 回执） | T1 ①rewind 协议面重设计：`rewind/list` 回执带 `CheckpointMeta[]`+external 变更标注；`rewind/exec` 回执带 `restored[]`；先冻结回执 shape 契约（3 个 pty 探针压面板文案，测试席 P1-4）②面板换协议适配器 |
| 5 | **fork 语义（v1.1 归位）**：`forkSession`+`copyForResume`+SessionStart(resume) 属 **restoreSession 恢复流程**（976-1011「TUI 保持 fork 续写语义」），**不属于 rewind**（rewind 流程只有 appendRewind 留痕 1572-1574） | 无 | 附着语义重设计：session/restore 的 fork 续写语义宿主化（T1，见 §4.2） |
| 6 | 插话路径 hook dispatch（203-214，注释 200-202 明言「宿主仅新轮 dispatch——插话保留客户端 dispatch 维持旧行为」） | 插话注入宿主路径不过 hook（`session.ts:977-988`） | 语义拍板 D-T5：插话 hook 随 interjection 注入宿主化，或维持「插话不触发 hook」（Embedded 现状=插话经客户端 dispatch 会触发；两形态必须对齐一种语义） |
| 7 | `deps.lastUsage` ×5（230-233 四写/1769 一读） | `usage` 帧已带四维+ctx | 客户端 state 化（订阅 usage 帧维护），零协议改动 |
| 8 | `deps.config` useState（369）+ sandbox 读（280） | `config/get` + `config/changed` 帧 ✓ | 连接时拉取+订阅广播 |
| 9 | `deps.mcpManager.status()/reconnect/close/toolsOf`（838-862/1058-1062/1447-1456/1465） | `panel/data`(mcp) **死命令**；写动作无 op；`McpServerStatusView` 仅 {name,status} 远贫于面板要的 `McpServerSnapshot[]` | T1：panel/data(mcp) 回执升级富快照 + **新 op `mcp/action`**（reconnect/close，测试席 P1-8）+ toolsOf 随回执 |
| 10 | `deps.skillRegistry.listForCompletion()/shadowedEntries`（1080/1430） | 无轻量列表命令 | T1：panel/data(skill) 回执含 completion 列表+shadowed 计数；listForPrompt 属宿主侧 |
| 11 | `/skill-create` 整链 `providerRegistry.getByType`+callLLM（866-872）+`skillRegistry.get/install`（874/888/917） | 无（LLM 调用在宿主） | 见 §8 D-T2（附着态禁用挂账 vs 协议化） |
| 12 | `deps.pluginLoader` → PluginPanel（1459-1465，browse/list 同步 IO+install/enable/disable/uninstall 动作面+skillRegistry/tools/mcp 三对象 props） | `panel/data`(plugin) **死命令** | 数据+动作两面都要协议化，最重——D-T2 挂账选项的主因 |
| 13 | `deps.mcpWarnings/instructionWarnings`（1071） | `notice`/`systemMsg` 帧已有 | 宿主项目 ensure/会话 subscribe 时推帧 |
| 14 | `deps.mcpPendingApproval`（1087-1109）——**项目 .mcp.json 首用批准门**（`setup.ts:32-36,89-95`，askSelect 批准/拒绝+approve() 二段接入） | **无任何帧可走**（≠`approval/requested(kind=mcp-permission)` 扩展 hook 授权——v1.1 改正开发席 P0-1 的张冠李戴） | T1 新增协议面（或 D-T2 式挂账）：附着态 MCP manager 在 daemon，此门必须过协议 |
| 15 | `deps.skillHooks` register/unregisterAll（788/1667） | 无（进程级 skill hook） | 宿主侧职责（随 SessionStart 宿主化），TUI 不再注册 |
| 16 | `readClipboardImage`（267） | — | 客户端本地行为，保留 |
| 17 | 装配面 makeConversationDeps/makeProjectDeps 整块（441-458） | — | **单路径全协议化机制下退役**（§4.6） |
| 18 | `deps.logger`（749/972/1023） | — | TUI 进程本地 trace，保留 |
| 19 | `deps.tools.specs()`（958，checkModelWindow ctx 估算） | 无 | ctx 口径随 usage 帧的 contextUsed/contextWindow（F-44 已有）改帧驱动；specs 面随宿主 |

**B. `host.*` 直调面（v1.1 补，开发席 P0-2——T2 真正主体）**：

| # | 直调点 | 现状协议等价 | T 线动作 |
|---|---|---|---|
| B1 | `host.transcript` ×10（472/477/537/545-546/567-568/703-704/934/942-943/990）——渲染数据主源 | `session/read`（全量/分页）+ 事件帧（delta/item/completed/turn） | 客户端 transcript 管线改为「事件帧增量+session/read 回填」混合：附着态首屏 restore+read 重建 committed，随后帧增量（T2 核心，对齐 web store 模式） |
| B2 | `host.compactManual()`（941） | 无独立命令（仅 prompt 内 `/compact` 分流 `session.ts:506-511`） | T1 补 `session/compact` 命令（或 TUI 侧改发 prompt '/compact'——拍板随 T1 细化，倾向补命令保持命令面干净） |
| B3 | `host.restoreFrom()`（989） | `session/restore` ✓ | 改走命令 |
| B4 | `host.appendRewind()`（1572） | 无（rewind 留痕面） | 随 T1 rewind 宿主化（宿主 exec 内双写） |
| B5 | `host.mountBridges()/subscribe()/dispose()`（463-464/667） | —（装配面） | 单路径全协议化下退役/重造（dispose 不得杀 daemon 宿主——只断连接） |

### 3.4 测试与探针现状（测试席盘点）

- tests/tui 39 文件全部**手搓 inline deps**（不经 makeDeps），Embedded 路径 vitest 回归风险低；但 T2 后 `TuiApp.test.tsx:236-294`（restoreFull/forkSession 直调断言）、`TuiAppKeys.test.tsx:52-87`（noopHistory）、`TuiAppHooks.test.tsx:107-115`（SessionStart 时点）、`approvalDraft/approvalReason.test.tsx:96` 五文件装配重建+4 个面板组件测试（Rewind/Mcp/Skill/PluginPanel）数据源重接——**T2 估时必须含**；
- pty 探针 25 个无统一 runner；3 个直接压 RewindPanel 打开路径与文案（doublesc 64,78 / input-clear 53-56 / ctrlc-matrix 96-102）——rewind 回执 shape 冻结前不能动面板渲染；**全部 25 个受 T3 入口序影响**（裸入口 spawn 将静默变成 attach 路径）——需统一形态开关注入（G-T3 机制，§4.1）；
- `SkillPanel.tsx:12` 模块单例暗道（直接 import skillRegistry）——附着态读错注册表，T2 一并修。

## 4. 总体设计（v1.1 修订）

### 4.1 连接形态与入口分流

`ecode`（无 argv；**argv 单次模式 `ecode "问题"` 保持 Embedded 直跑不进 daemon——runonce-approval-probe 等既有语义不变**）：

```
读 server.json ──存在──▶ pid 探活 + GET /health（2s 超时）+ health.id 比对 + 版本比对
   │不存在/探活失败                       │
   ▼                                     ├─全过──▶ 附着：MultiTransport + 订阅 mux
拉起锁（~/.ecode/ 下 O_EXCL，架构席 P0-2）  │
   │锁内二次探活                          ├─版本不符──▶ 【不拉起】提示「ecode serve stop 后重开，
   ▼                                     │            或 ecode --local 本地模式」（D-T1a，安全席 P1-1：
spawn detached `ecode serve`             │            旧流程图把版本不符导向拉起=变相杀旧重建）
  stdio:'ignore' + windowsHide:true      └─health 不达──▶ 同上提示（不接管）
  + env 白名单（§4.5）                   （serve 侧配套改造：serveMode 发现「健康且版本一致的
   │轮询 server.json+/health               daemon 已在跑」→ 不接管、打一行提示后退出 0；
   ▼                                       接管仅保留给注册陈旧/health 不可达情形——架构席 P0-2）
附着（同上；锁释放）
   │失败
   ▼
自动降级 Embedded（顶栏提示「daemon 不可达，已切本地模式」）——`--local` 旗标跳过 daemon 直接 Embedded
```

- **spawn 细节（架构席 P0-1）**：`stdio:'ignore'`（TUI 退出后 pipe 断裂会让继承 stdio 的 daemon EPIPE 崩溃）、`windowsHide:true`（win32 detached=CREATE_NEW_CONSOLE 会弹窗，`src/cli/index.ts:308-314` 实证）、dev 形态 execArgv 显式拼进 argv（tsx loader 不自动继承，`index.ts:336-338`）；
- **server.json 原子写**：tmp+rename（现 writeFileSync 直写，与拉起锁竞态叠加会读撕裂——架构席 P2-3）；
- **日志**：daemon 日志固定用户级 `~/.ecode/logs/serve/`（现落 `process.cwd()/.ecode/logs`——detached 后 cwd 锚定在首次拉起目录，漂移）；
- **TUI 退出不杀 daemon**（detached 常驻）；`ecode serve stop` 显式停；
- **运行中 daemon 消失**（SSE 重连 3 次失败）：顶栏错误横幅+建议 `--local` 重开，**不自动降级**（重建宿主会丢审批/插话队列等宿主态）；**重开 TUI 时**入口序自然重拉（§4.4 与 G-T4 统一口径：自动重拉只发生在「新 TUI 进程入口序」，运行中永不自动）。

### 4.2 会话归属与双端仲裁（全部复用既有宿主语义，零新设计）

| 场景 | 语义 | 依据 |
|---|---|---|
| TUI 附着时选会话 | `session/restore`（ensure 语义）→ 宿主确保存在，历史经 session/read 回填 | M13 会话级宿主 |
| **fork 续写语义宿主化（v1.1 新增，开发席 P1-2）** | 现状 TUI 恢复会话=fork 新 id 续写（TUI 本地 forkSession+copyForResume+SessionStart(resume)）。附着态该流程移入宿主：session/restore 命令扩展 `fork:true` 语义（宿主完成 fork+checkpoint copyForResume+SessionStart dispatch+回执新 sid），**两形态行为一致** | 开发席 P1-2 |
| 「当前会话」 | **per-client**：各端本地选中态（web store 现行模式），事件全量收+本地按 sessionId 分发，切会话零重连 | opencode 先例+web 现行 |
| 双端看同一会话，A 插话 | 宿主插话队列串行注入，B 侧收到 interjection 帧 | M11 |
| A 中断 | `interrupt`，双侧同帧收敛 | 既有 |
| 双端同时审批 | claim（认领显示）→ respond（裁决）→ resolved 广播；后答者 ok:false 幂等收敛 | C2⑤ |
| /compact | T1 补 `session/compact` 命令（宿主已有压缩链，`session.ts:506-511` 分流复用） | 开发席 B2 |

### 4.3 hook 宿主化（v1.1 按两席复核重写缺口清单）

**现状基线（先摆准）**：UserPromptSubmit **新轮路径宿主 dispatch 已存在**（`session.ts:817-833`：block→systemMsg+拦截、additionalContext→拼 input；web 发消息已触发）；TUI 客户端 dispatch（203-214）服务的是**插话路径**（宿主插话注入不过 hook，TuiApp 注释明言维持旧行为）。SessionStart **宿主零 dispatch**（仅 TuiApp 1006/1044，且 additionalContext 经客户端 pendingSessionCtxRef 注入首轮 706-710）。

T1 hook 真实工作量：
1. **SessionStart 宿主化**：session/new（multi 拦截 ensure 路径，source:'startup'）与 session/restore(fork)（source:'resume'）各 dispatch；session_id 用真实 sid（现 TUI 硬编码 ''，顺手修）；
2. **SessionStart 产物跨进程承载**：宿主 dispatch 后 systemMessages→systemMsg 帧、additionalContext→**宿主暂存+拼进该会话下一轮 input**（宿主新增 pendingSessionCtx 等价物，协议无需新帧——additionalContext 本就该进模型输入而非客户端 UI）；
3. **插话 hook 语义拍板（D-T5）**：倾向=插话注入路径（pollUserInput）宿主化后接 UserPromptSubmit dispatch，两形态语义对齐为「插话也触发」；若拍板维持「插话不触发」，则 TuiApp 203-214 客户端 dispatch 直接删除（附着态插话走 interjection 命令，客户端 dispatch 无处安放）；
4. **hook cwd 修正（安全席 P1-3）**：hook 执行 cwd 必须用**会话项目 cwd**（现 exec.ts:73 用 process.cwd()——Embedded 下恰=TUI cwd=项目目录，宿主化后 daemon cwd≠项目目录，守卫类 hook 会跑错树）；Embedded 形态同修（行为统一）；
5. **触发面扩大披露**：宿主化后 web/飞书（LAN 凭据持有者）可经 prompt 触发项目 hook 执行——接入 approval 审计流（同 sink，`approval.ts:40` 同款）；
6. skillHooks 进程级注册随宿主化移宿主（#15）。

### 4.4 降级与版本

- 附着前四验（§4.1）：pid 探活+health+health.id+版本；版本不符**绝不 spawn**（安全断言回归项）；
- server.json 注册 schema 扩 version 字段（现无，`serveMain.ts:157`）；旧 daemon 注册文件无 version → 视为版本不符走提示路径；
- 附着态 daemon 死亡：横幅不自动降级（§4.1）；`--local` 与自动降级路径下审批/沙箱行为与现状行为等价验收（pty 哨兵全绿）。

### 4.5 安全决策（v1.1 新增节，安全席 P0×2 回填）

1. **TUI 附着凭据=primary token**（server.json 唯一凭据载体，本机进程语义）：显式决策记录——primary 经 multi cmd 路由派生 confirm 豁免，与 Embedded 直连无栅栏等价，可接受；T8（本机恶意进程读 server.json 代答审批）**能力不变、窗口扩大**（daemon 常驻+无人值守时段），边界收口仍在 R1 per-device 凭据——本节即披露；可选最小加固（随 T4，不等 R1）：mux canAnswer 计入 fail-closed 判定绑定 `credClass ∈ {primary, lan-password}`；
2. **auto-spawn env 白名单（P0-2 主修）**：detached 拉起时 serve 绑定三元组（ECODE_SERVE_HOST/PORT/SERVER_PASSWORD）**只认 TUI 进程的外部环境变量，不回退项目 .env**（dotenvMap 回退在 auto-spawn 路径禁用）——否则恶意仓库 .env 写 `ECODE_SERVE_HOST=0.0.0.0`+密码即可经日常 `ecode` 静默制造局域网常驻暴露；spawn env 显式白名单（PATH/SHELL/HOME/USERPROFILE/ECODE_*/ANTHROPIC_API_KEY 等运行必需），shell export 的杂项 env 不长驻 daemon；
3. **daemon 身份双验**：附着前 pid 探活+health.id 比对（防陈旧/预置注册文件误附）；信任根仍=「网络可达+token」（与 R 线 §2 一致，T 线不扩大），R1 per-device+公钥 pinning 为终极收口（已在 R 方案 §5.2）；
4. **--yes/approvalPolicy 附着态传播（安全席 P1-4，D-T6）**：倾向=附着握手声明、宿主按会话生效（session 级 approvalPolicy，broker 已支持 per-session 策略面）；禁「daemon 全局 auto-approve」实现（另一端无感知的旁路）；
5. **G-T 补安全断言 6 条**（§7）。

### 4.6 装配机制：单路径全协议化（架构席 P1-5 拍板采纳）

Deps 拆为**客户端面**（transport/本地偏好/logger/剪贴板/客户端 state）与**宿主面**（providerRegistry/tools/checkpoint/quality/orchestrator/history/mcpManager/checkpoint…）。TuiApp **只依赖客户端面+ClientTransport**；宿主面消费全部改走命令/帧（§3.3 映射表）。形态差异=装配点注入 `InMemoryChannel`（Embedded）还是 `MultiTransport`（附着）——**单一 TuiApp 代码路径，无形态分支**；「进程内不绕」铁律（channel.ts:29-31）本就要求协议语义不因同进程打折。宿主面字段从客户端 Deps 类型**删除**，编译器逼出全部残留消费点——映射表穷尽性问题机械解决。G-T3 表述相应改为「行为等价验收」（实现路径不再是现状代码路径）。

## 5. 实施批次（v1.1 按四席估时修订）

| 批 | 内容 | 估时 | 验收 |
|---|---|---|---|
| T1 协议补齐 | ① rewind 协议面重设计+接线（list 回执 CheckpointMeta[]+external 标注；exec 回执 restored[]；shape 契约冻结测试先行）② fork 续写宿主化（session/restore 扩展 fork:true）③ panel/data 两面板（skill/mcp）View 契约+接线 ④ 新 op mcp/action（reconnect/close）⑤ .mcp.json 批准门协议面（mcp/approve）⑥ hook 宿主化四件（§4.3，cwd 修正含 Embedded；TuiApp 客户端 startup/插话 dispatch 删除防双跑）⑦ session/compact 命令 ⑧ **实施更正：skill/install 撤下**——install 唯一调用面是 /skill-create 蒸馏流程（无独立市场安装语义），随 skill-create 挂账（D-T2）⑨ 审批超时语义改造（D-T8：默认 1h+可配；超时如实反馈 APPROVAL_TIMEOUT_FEEDBACK 引导模型决策，不再谎称拒绝）⑩ 协议清理（删 command/exec/config/patch；panel/data 去 doctor）⑪ mcpWarnings/instructionWarnings 转 notice 帧（首订阅 flush——构造期无订阅者即时发必丢） | 3.5-4 天 | 全量门 1673+3skip；契约测试（rewind list/exec/BUSY/fork 播种/applied 帧/面板 View/批准门/超时如实反馈）|
| T2 TuiApp 单路径切换 | §3.3 A 面逐点+B 面（transcript 混合管线为主体）；Deps 宿主面删除由编译器兜底；5 个测试文件装配重建+4 面板组件测试重接+SkillPanel 单例暗道修 | 2.5-3 天 | 全量 vitest 绿（含重建测试）+tsc 净+Embedded pty 哨兵全绿 |
| T3 入口 daemon 化 | §4.1 入口序全件：拉起锁/stdio+windowsHide/execArgv/env 白名单/原子写/version schema/health.id 四验/serve 接管改造（健康+版本一致→退出）/日志目录/`--local`+自动降级/探针形态开关统一注入（ECODE_FORCE_EMBEDDED=1）+探针聚合 runner（`npm run probes`）；**主机别名上报+双端顶栏显示**（多机区分，2026-08-31 用户补：`ECODE_SERVE_NAME ?? os.hostname()` 入 server.json+config/get，web/TUI 顶栏常驻显示「当前连的是谁」——多台电脑各自 serve 时标签页一眼分清） | 2-2.5 天 | pty-attach-probe 断言 1/2/6/7/9/10/11/12 + 别名显示断言 |
| T4 MultiTransport+per-client | 新写 MultiTransport（multi 信封+project 路由+可变 sid+游标 sinceSeq/gap 补同步——web connect.ts 蓝本）；clientID 分配+帧 origin 标记（本地 UI 动作不广播）；canAnswer:true+credClass 加固（§4.5.1 可选项） | 1.5 天 | L2 双客户端集成测试（delta 双达/插话可见/审批 claim-respond 收敛/origin 不回环/canAnswer 计入 fail-closed） |
| T5 断连与真机门 | 附着态 daemon 死亡横幅；undici reader/SSE 断连两坑复查；G-T 真机验收 | 1-1.5 天 | G-T 全门 |

合计 **11-12.5 人天**（v1.2 拍板增补：skill/install 协议化+审批超时语义改造+顶栏 daemon 状态标识）。

依赖：T1→T2→T3→T4→T5 串行为主（T4 可与 T2 尾部并行）。R1（配对）以 T3/T4 为前置（设备凭据绑定 multi 信封连接）。

## 6. 明确不改的

- 宿主两层结构（ProjectHost/ConversationHost）、审批 broker、插话队列、mux 帧信封——全部复用；
- web/飞书客户端零改动（帧字段只增不改；web connect.ts 的游标/信封模式是 T4 蓝本而非改造对象）；
- Embedded 形态**行为**完整保留（单路径机制下实现与现状不同但行为等价验收，§4.6）；
- argv 单次模式（`ecode "问题"`）不进 daemon；
- CC 式云端 bridge 路线不取。

## 7. 验收门（G-T，v1.1 含测试席 12 条探针断言+安全席 6 条安全断言）

**自动化主体 = 新探针 `scripts/pty-attach-probe.cjs`（tmpHome+mock SSE+detached serve+TUI）**：

1. 冷启动：server.json 出现且 pid 唯一，TUI 附着态标识出现；
2. 提交 prompt → TUI 流式渲染（mock 慢流）；
3. 第二 SSE 客户端直连 mux → 与 TUI 同帧逐帧一致（seq 单调无丢失）；
4. 第二客户端发插话 → TUI 帧面出现排队/注入行；
5. mock 回 bash tool_use → 审批卡双侧出现；第二客户端 claim→respond → TUI 卡收敛；二次 respond 幂等吸收；
6. TUI Ctrl+C 退出 → daemon 存活（/health 200），慢流跑完落 session/read；
7. 重开 TUI → 秒附（<2s）且首屏 committed 含前轮 user/assistant 行；
8. kill daemon pid → TUI 错误横幅、**不**自动降级、进程不退；
9. 预写假版本 server.json → 拒附着+提示、**不杀旧 daemon、不 spawn**（D-T1+安全断言⑤）；
10. `--local`：无 server.json 读写、无 daemon 拉起（Embedded 证据）；
11. `ecode serve stop` → 注册删除 → 重开 TUI 自动重拉附着；
12. 双开第二个 TUI → 无第二 daemon、秒附；**并发双开冷启动竞态**（架构席 P0-2 回归）：两 TUI 同时首启仅一 daemon 存活、两者均附着成功。

**安全断言（并入上述探针与 host 测试）**：①token 错误附着 401 且停泵不无限重连；②TUI 退出（零 canAnswer 订阅者）后新建审批即时 fail-closed（观察型连接不撑破 sensitive 门）；③daemon 拉起失败不留裸端口/残留 server.json（spawn 失败/serve 拒启/绑定失败各路径）；④auto-spawn 非 loopback 绑定必须拒绝（.env 注入面回归，§4.5.2）；⑤版本不符绝不 spawn（探针断言 9）；⑥server.json 权限（POSIX 0600；Windows ACL 差异文档披露不做断言）。

**G-T 真机门（一次性手动冒烟）**：局域网手机浏览器对 G-T1 场景（实时流/插话/审批）人工确认——web 前端渲染不在自动化断言面（web/src 无前端测试基建）。

**回归门**：全量 vitest+tsc 净+25 个 pty 探针经聚合 runner 全绿（形态开关注入 Embedded 变体；attach 变体随 pty-attach-probe 覆盖）。

## 8. 决策点（D-T，2026-08-31 用户已全部拍板）

| # | 决策 | 拍板结果 |
|---|---|---|
| D-T1 | daemon 版本不匹配策略 | **a) 拒绝附着+提示**（保住跑着的任务；版本不符绝不 spawn） |
| D-T2 | skill/MCP/Plugin 远程能力范围 | **远程「用」与「装」本线协议化**（用户定调：远程安装也是装到用户本地——skill/install 走宿主命令、panel/data 全量；**/skill-create 与 PluginPanel 挂账**）——数据归属澄清见下 |
| D-T3 | 附着态 TUI 退出提示 | **a) 轻提示一次 + 增补：TUI 顶栏常驻 daemon 运行状态标识**（附着中/本地模式，用户要求「前台上要能够看到后台是否在运行」） |
| D-T4 | Embedded 进入方式 | **a) 自动降级 + `--local` 显式** |
| D-T5 | 插话触发 UserPromptSubmit hook | **a) 触发**（插话注入宿主路径接 dispatch，全端行为一致） |
| D-T6 | --yes 附着态传播 | **a) 会话级声明**（与 D-T2 数据原则无冲突：策略非数据；sensitive 门不豁免的既有语义不变） |
| D-T7 | .mcp.json 批准门 | **a) 本线协议化** |
| D-T8 | 附着态审批超时 | **放宽默认 1h+可配，且超时反馈语义改造**（用户增补：超时后**如实告知模型「超时无人应答」**——不得谎称「用户拒绝」；让模型自主决策：换方案/先跳过并记录待办） |

**数据归属澄清（D-T2 用户定调的架构对齐）**：daemon 常驻在**用户电脑上**（非云端），skill/MCP/会话历史/配置全部是**电脑本地文件**；手机等远程设备自身不携带任何数据，只是 daemon 的遥控端——「远程安装 skill」= 装到电脑本地，回到电脑 TUI 看到的是同一份。多客户端（TUI/web/飞书）共享的正是同一台电脑的同一批本地资源，**无任何数据进 daemon 私有存储或云端**。

附带记录（后续增强，不在本线）：开机自启（daemon 注册系统服务）、托盘常驻、server.json Windows ACL 校验、安全配置热重载（blockedCommands/sandbox 快照陈旧窗口随常驻拉长——安全席 P2-3，文档声明+热重载随需）、/skill-create 与 PluginPanel 的协议化（D-T2 挂账部分）。

**多机场景记录（2026-08-31 用户提出：两台电脑各自跑 ECode，手机如何区分）**：每台电脑=独立 daemon=独立地址，数据天然隔离；T3 的主机别名+顶栏显示解决「分不清哪个标签页是谁」；「手机一个入口管理多台电脑」（配对命名+设备列表+在线状态+点谁进谁）是 R1（配对 offer 带主机别名）+R2（relay 汇聚多 daemon）的交付面，已同步补进 R 方案（见该方案变更记录 v1.1）。

## 9. 变更记录

- v1.0（2026-08-31）：起草。三路调研回填（opencode v2 daemon 全链/codex 三态+resume 即 attach/orca 生命周期三层+重放 epoch）；ECode 直调面 18 点映射+死命令 5 个实锤；批次 T1-T5 估 6.5-8 人天；决策点 D-T1~T4。
- v1.1（2026-08-31）：四角色审阅修复吸收——**架构席**：P0-1 spawn stdio/windowsHide/EPIPE、P0-2 serve 接管语义改造+拉起锁+竞态断言、P1-1 HttpTransport 移出零改动表（T4 新写 MultiTransport）、P1-3 §4.4 与 G-T4 统一口径、P1-4 version schema 现状、P1-5 单路径全协议化机制（§4.6）、P1-6 W-9 游标入 T4、muxFilter 术语修正（全量收+本地过滤）、argv 豁免/tsx execArgv/日志目录/原子写入文；**开发席**：P0 host.* 直调面补表（B1-B5）、P0 #14 改写（.mcp.json 批准门无帧可走）、P1 fork 归位 restoreSession 流程（§4.2 宿主化）、P1 rewind 回执三面重设计、P1 session/list includeArchived 行为差、17 非 18/doctor 非面板/SkillPanel 暗道；**安全席**：P0 §4.5 新增节（凭据语义+env 白名单+身份双验+T8 披露）、P1 流程图版本不符改不拉起、P1 hook cwd 修正、P1 --yes 传播（D-T6）、安全断言 6 条入 G-T；**测试席**：P0 hook 现状基线重写（§4.3）、P0 探针形态开关+聚合 runner、P0 测试破面入 T2、pty-attach-probe 12 断言入 §7、估时重排、D-T5/D-T7/D-T8 新增。
- v1.2（2026-08-31）：**D-T1~T8 用户全部拍板**——D-T2 按「数据归属本地、daemon 非云端」定调细化为 skill/MCP 用+装本线协议化（/skill-create 与 PluginPanel 挂账）；D-T3 增补顶栏 daemon 运行状态标识；D-T8 增补审批超时反馈语义改造（如实告知+模型自主决策）；T1 批相应扩至 3.5-4 天，总量 11-12.5 人天。状态转实施中。
