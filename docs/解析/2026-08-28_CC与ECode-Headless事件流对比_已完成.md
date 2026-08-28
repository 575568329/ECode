# CC 与 ECode Headless 事件流对比（serve 实验批调研）

源：`D:/study/claude-code-main`（简称 CC，src 行号锚点）× ECode `src/`。2026-08-28。

## 1. 调用形态与参数面

- **CC 做法**：`claude -p "<prompt>" [--output-format text|json|stream-json] [--verbose] [--max-turns N] [--resume <id>] [--permission-mode <mode>] [--allowed-tools ...] [--permission-prompt-tool <mcp_tool>] [--dangerously-skip-permissions] [--mcp-config ...]`。入口 `src/cli/print.ts`（5594 行单文件 headless 心脏）；`stream-json` 强制要求 `--verbose`（print.ts:787-791）；NDJSON 干净度靠 `installStreamJsonStdoutGuard()` 把非 JSON 杂写改道 stderr（print.ts:594-597，实现在 `src/utils/streamJsonStdoutGuard.ts`）。
- **ECode 做法**：`ecode serve` 常驻 daemon，HTTP `POST /api/p/<proj>/cmd`（ProtocolCommand，`src/protocol/types.ts:87`）+ SSE 事件流；无单发 headless 进程形态。
- **差异与借鉴**：CC 是**一进程一轮**的管道模型（stdin/stdout，编排器友好、CI 可直接 spawn）；ECode 是常驻多项目模型。可借鉴：① stdout guard 思想对应 ECode 的 SSE 帧纯净度（已有 drain/背压，等价物）；② 单轮预算参数面 `--max-turns`/`--max-budget-usd`（result 帧回显 error_max_*，print.ts:940-951）——ECode 有 loopGuard 但未协议化为命令参数。

## 2. stream-json 事件类型与字段

- **CC 做法**：权威 schema `src/entrypoints/sdk/coreSchemas.ts`，总联合 `SDKMessageSchema`（:1854-1882，24 成员）。关键帧：
  - `system/init`（:1459）：版本/cwd/tools/mcp_servers/skills/plugins/permissionMode——**连接即自描述**；
  - `assistant`（:1349）：内嵌完整 Anthropic API message（text/thinking/tool_use blocks 原样）+ `parent_tool_use_id` 关联子代理；
  - `user`（:1275）：工具结果以 user 帧回带，附 `tool_use_result`；
  - `stream_event`（:1498）：LLM 原生流事件透传（raw delta，细粒度增量）；
  - `result`（:1407-1454）：终帧，subtype `success|error_during_execution|error_max_turns|error_max_budget_usd|...`，带 `duration_ms/num_turns/total_cost_usd/usage/modelUsage/permission_denials`；
  - 系统/生命周期类：`compact_boundary`、`status`、`api_retry`、`hook_started/progress/response`（print.ts:628-670 注册）、`task_notification/started/progress`、`session_state_changed`、`rate_limit_event`、`streamlined_text`（精简模式裁剪帧）。
- **ECode 做法**：`ProtocolEvent` 30 帧（types.ts:50-85）：delta（文本增量）/item·started·completed（工具，content 4KB 截断+item/read 全文）/turn·started·completed/usage/thread·status/approval 三帧/askUser/interjection/todo/subagent 等，每帧带会话级单调 `seq`（顺序/去重/分页游标三用）。
- **差异与借鉴**：CC 复用 **API 原生消息粒度**（assistant/user 即 transcript 重放单元，-resume 可原样回喂）；ECode 自造细粒度 UI 事件帧（delta/item 分离，序列化纪律更强、带截断+按需读）。可借鉴：① `system/init` 自描述帧——ECode 会话冷启动可发一帧 model/tools/mcp/skills 快照，客户端免拉 config；② result 终帧的 `permission_denials`（被拒工具调用清单）与 `stop_reason`——ECode `turn/completed` 不带终止原因与拒批汇总，排障/编排断链判定缺位；③ `stream_event` 透传层证明「原始流+语义帧」可并存——ECode delta 已是此式的简化版。

## 3. headless 权限审批通路

- **CC 做法**：三条路：① `--permission-prompt-tool <mcp_tool>`——把审批委托给一个 MCP 工具，CC 调该工具即问询（print.ts:4299-4262 `getCanUseToolFn`，MCP 工具从工具表排除 :824-830）；② SDK 模式（`--sdk-url`/stdio）走 **control_request 双向协议**：CC 向宿主发 `{type:'control_request', request:{subtype:'can_use_tool', tool_name, input, tool_use_id, permission_suggestions...}}`，宿主回 control_response 带行为 allow/deny/update（`src/cli/structuredIO.ts:177,592`）；且 **PermissionRequest hook 与 SDK 问询竞速**，先到先得、败者取消（structuredIO.ts:560-620）——UI 即显、hook 后台跑；③ `--dangerously-skip-permissions`（bypassPermissions，事后不可切回，print.ts:4574-4595）。挂起中的审批在重复 initialize 时以 `pending_permission_requests` 回放（print.ts:4370-4377）。
- **ECode 做法**：`approval/requested → claim → respond` 三帧+三命令（types.ts:63-65,89-90），ApprovalBroker 挂起式；mux 观察连接须 `canAnswer=1` 才计入 sensitive fail-closed 判定（multi.ts:270-272）；审批 15min 超时（M13-B2）。
- **差异与借鉴**：CC 的请求/应答在**同一条 stdout/stdin 流上以 request_id 配对**（单进程双工）；ECode 走独立 HTTP 回程+claim 防多端抢答。可借鉴：① **hook 与宿主问询竞速**——ECode hook 与审批目前是串行链，竞速可消 hook 慢时的 UI 挂起；② pending 审批重放到新连接——ECode 已做（HostSession.subscribe 补订），对齐确认即可；③ `permission_suggestions`（建议决策随问询下发，宿主 UI 可渲染「始终允许」快捷项）——ECode decisions 数组语义近似，可补 suggestions 字。

## 4. 接入成本对比（对 /api/events.mux）

- **CC 做法**：消费者 = spawn 子进程 + 读 NDJSON 行流（stdout 单向下行；control_request 上行走 stdin JSON 行）。无鉴权、无重连、无游标——进程死了流即断，靠 `-c/--resume` 手动续。事件面广（24 类）但字段随 API schema 演进，客户端需持 zod schema 消化。
- **ECode 做法**：`GET /api/events.mux` 单 SSE 流（Bearer token+loopback+drain 背压+15s 心跳，multi.ts:259-330），MuxFrame 信封 `{project, sessionId, ev}` 或 `{host}` 生命周期帧；`?sessionId=` 客户端自报过滤（强制过滤挂 R 线）；baseline（session/baseline 活清单）→ pending 审批重放 → 持续广播三连；上行命令走 `POST cmd`。接入=一个 EventSource+一个 fetch。
- **差异与借鉴**：ECode 接入成本显著更低（重连/游标/鉴权/多项目聚合都内置；CC headless 全要编排器自己造）。CC 优势仅在「零网络、管道原生、CI 免 daemon」。可借鉴：CC 的 `--resume <session_id>` 单命令续会话语义极简，ECode `session/restore` 对应已有——等价。

## 5. stream-json 对 ECode serve 的可借鉴点（汇总）

1. **result 终帧富化**：turn/completed 补 `stop_reason`、`num_turns`、`permission_denials`、`duration_ms`——编排断链判定与成本归因一帧可得（coreSchemas.ts:1407-1428）。
2. **system/init 自描述帧**：会话冷启动快照（model/tools/mcp/skills/permissionMode），客户端免二次拉取（:1459-1496）。
3. **hook 与审批竞速**：Promise.race 先到先得（structuredIO.ts:595-620），消 hook 慢阻塞审批 UI。
4. **审批问询带 suggestions**：`permission_suggestions`/`decision_reason` 随 can_use_tool 下发（structuredIO.ts:592-601）。
5. **streamlined 精简模式**：按需把 assistant 帧裁成 `streamlined_text`/`streamlined_tool_use_summary`（coreSchemas.ts:1366-1394）——ECode mux 可类比出「低带宽移动端视图帧」。
6. **stdout 纯净度守卫**：非协议输出改道 stderr（print.ts:594）——SSE 侧等价物已备，仅作对照。
不建议照搬：NDJSON-over-stdout 单工形态（无鉴权/重连/多路复用，ECode 常驻多项目模型下是倒退）。
