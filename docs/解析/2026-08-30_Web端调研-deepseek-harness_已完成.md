# Web 端调研：deepseek-harness（client 插件包体系）

> 日期：2026-08-30 · 状态：已完成
> 对象：`D:\study\deepseek-harness`（React18 + Vite6 pnpm monorepo；前端主体在 `packages/client/` 下约 40 个 `ui-*` 插件包，`apps/web` 是 8 行薄壳）。ECode 此前布局批（AppFrame/常驻 composer）已参考过它，本文补全其余维度。六份对标分析之二。

## 1. 定位

「AI 编码 harness 的 Web 控制台」：三栏 grid（sidebar | center | details）+ 插件式 slot 组合 + host 权威快照帧。与 ECode 同为「daemon 权威、前端为纯视图」的架构取向，其 slot 命名法与快照帧思想是最独特供给。

## 2. 技术栈与架构要点

- 无 Tailwind：全量 CSS Modules + `--dsw-*` CSS 变量令牌（`ui-theme` 包先行注入）。
- 状态：自研 snapshot store（`packages/client/runtime/src/client/contract/store.ts` 的 `createSnapshotStore`/`defineStore`）+ `useSyncExternalStore` selector。
- 分包：`ui-conversation`（消息流+composer）/ `ui-sidebar` / `ui-workspace`（会话列表）/ `ui-tool`（工具卡）/ `ui-primitives`（DiffBlock/MarkdownText）/ `ui-input-trigger`（斜杠/@触发器）/ `ui-slots`（slot 机制，single/list/keyed/chain 四种）。
- 构建手工分包：katex/shiki/micromark 进 React-free vendor chunk，shiki 语法按语言懒加载。

## 3. 关键设计（附路径）

1. **WS 下行 + HTTP 上行的严格分工**（`packages/client/connection/src/websocket-downlink.ts`）：WS 只承载 server→browser 流（mux + host 两条），客户端任何上行消息视为协议违规（close 1008）；上行全走 unary RPC。
2. **全量快照帧做多方收敛**（`packages/host/apiproxy/src/api/events.ts`）：`session/queue`、`session/jobs` 每次变化重发**整个集合**——注释原文"a start, a kill, a reconnect, and a second tab converge on one authoritative value"；重连时逐 session 重放仍未决的 approval/question 帧作恢复基线。
3. **增量 markdown 冻结渲染**（`ui-primitives/src/markdown/MarkdownText.tsx` + `incremental.ts`）：「除尾部两块外全部冻结为缓存 React 元素，每 chunk 只重解析尾部源码」；冻结块带 source-offset key 走 reconcile 不重挂；流式期间 fence/TeX 渲染 plain，finalize 才上高亮+KaTeX。自研 mdast 直解管线（micromark+gfm+math），不用 react-markdown。
4. **Composer takeover 链 + 分区命名法**（`ui-conversation/src/client/contract/slots.ts`）：审批/提问沿 `conversation.composer` chain slot 选举替换 composer（InputBar hide 不 unmount，textarea DOM 存活）；优先级 question > approval（"a question is a conversation, an approval only blocks one tool call"）；分区命名 `input.dock`（卡上整行）/`composer.dock`（卡下读出）/`input.left/.right`/`input.plan`/`input.model`——附件栏、todo strip、统计行、斜杠/@补全各有预留席位，新增零侵入。
5. **会话行四态点语义**（`ui-workspace/src/client/rows/Rows.tsx` `sessionStatuses`）：待交互（amber）> 运行中（蓝）> 子代理运行数 > completed 提醒点（仅未打开过时显示）> idle；`StateDot` 四色 + ongoing 追逐动画。
6. **Breakpoint-free 三栏让步链**（`ui-layout/src/client/columns.ts` `computeColumns` 纯函数）：保 center ≥640 → 收缩 details → 自动关 details → center 吸收；窄屏折叠只翻转 override 不覆写用户宽度偏好，变宽自动还原；AppFrame 监听自身宽度（ResizeObserver + rAF）而非 window。
7. **滚动工程**（`ui-conversation/src/client/chat/ChatView.tsx`）：per-key `ChatNodeSeat` 单独订阅（助手 delta/工具生命周期只替换自己的行）；bottom-follow 按「尾部签名」变化触发防惯性滚动被 snap；observed-top 台账区分「读者滚动」与「程序写入」；prepend 分页锚 + 位移恢复。
8. **列表其余**：搜索 250ms debounce 走 host `session.search`（本地元数据+远端内容合并，AbortController）；每组默认 5 行 + 展开钮；archive 直接提交无确认框；拖拽排序乐观写本地 + RPC 持久化。

## 4. 审批/移动

ApprovalPanel：amber "Waiting for approval" strip + model 理由 headline + 内容区内部滚动但**按钮行恒在滚动区外**；一次性 latch、失败 re-arm。危险档（danger-full-access）需 RiskConfirmation 显式 checkbox。移动：唯一硬断点 1024（rail 折叠）；Safari 专项 textarea 布局修复 + IME composition 延迟清标志；无 visualViewport hack；PWA 仅 manifest（fullscreen）。

## 5. 对 ECode 的借鉴结论

快照帧思想（ECode 的 queue/snapshot 已同构，可扩展至 jobs/审批重放）；takeover 链 + 分区命名法（ECode composer 的附件/斜杠/@/todo 预留位设计模板）；增量冻结渲染蓝本；三栏让步链纯函数；四态点语义。反面：40 包 monorepo 与 slot 抽象的复杂度只在插件生态规模下才值回成本。
