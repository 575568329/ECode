# Web 端调研：OpenHands（agent-canvas）

> 日期：2026-08-30 · 状态：已完成
> 对象：`D:\study\OpenHands`（新版单体布局，前端在仓库根 `src/`，包名 `@openhands/agent-canvas`；React 19 + React Router 7 framework mode + Zustand5 + React Query + Tailwind4 + HeroUI）。已从旧版 Redux Toolkit + frontend/ 迁移。六份对标分析之三。

## 1. 定位

「Agent 事件流 + 工具执行工作区」形态的代表：action/observation 事件流、连续工具折叠、右侧工作区五 tab（files/commits/planner/terminal/browser）、确认模式审批。与 ECode 的事件模型最接近（工具调用+结果回链+审批）。

## 2. 技术栈与架构要点

- 路由集中在 `src/routes.ts`：会话即 URL（`/conversations/:conversationId`）、移动工作区独立路由 `/conversations/:id/panel`、只读分享路由 `/shared/conversations/:id`。
- 状态：`src/stores/` 27 个扁平单例 Zustand store（一域一文件），UI 偏好用 `zustand/persist`；服务端状态全归 React Query（hooks/query/ 50+ 钩子）。
- 三层 CSS 变量：灰阶 + HeroUI HSL 通道 + `--oh-*` 业务 token（`src/themes/color-themes.ts`，三套主题为变量覆盖 map）。

## 3. 关键设计（附路径）

1. **双轨事件 store**（`src/stores/use-event-store.ts` + `src/utils/handle-event-for-ui.ts`）：`events`（全量原始流，Set 去重 + 时间戳乱序重排）与 `uiEvents`（渲染流）分离；`handleEventForUI`（约 450 行纯函数）负责——最终事件到达**原位替换**流式 delta；Observation 按 `action_id` 原位替换 Action（工具卡 running→result 不重挂载）；中间工具事件清除 delta 里重复的 thought。
2. **rAF delta 批处理器**（`src/utils/streaming-delta-batcher.ts`，76 行）：每帧至多一次 store commit；非 delta 事件前强制 flush（防穿越）；会话切换 reset 防串台。零依赖。
3. **连续工具折叠组 EventGroup**（`src/components/conversation-events/chat/group-events.ts` + `event-group.tsx`）：连续可分组事件（run≥2）折叠，折叠态显示「最新动作标题 + N/M completed + spinner」，结束后退化为 "N actions completed"；agent thought 提升为独立项不埋进组；分组建档清单（markdown 产物/Think/Finish 是断路器）。
4. **类型安全工具卡注册表**（`src/components/features/chat/tool-visualizers/define.ts` + `index.ts` + `dispatcher.tsx`）：`defineVisualizer({actionKinds, observationKinds, Body})` 每工具一文件，未注册工具自动走 markdown 管线；bash 卡带 security_risk 红字与 exit_code 徽标；编辑卡按 str_replace/insert/create 分形态（md 产物走富文本预览而非源码堆砌）。
5. **无依赖 LCS DiffView**（`tool-visualizers/primitives/diff-view.tsx`，~150 行）：行级 diff，首尾公共行裁剪留 3 行上下文，300 行截断，old×new 超 25 万格跳过 LCS 直接整块替换（防全文件重写卡死）。
6. **重连模型**（`src/contexts/conversation-websocket-context.tsx`）：REST-first 拉最近 50 条历史 → WS 带 `resend_mode='since'&after_timestamp` 续传，重叠靠事件 id 去重；初始历史 pending 期间故意不连（注释记录了"后台 refetch 拆活 socket 致重连风暴"事故）；退避 1s→30s + 30% 抖动；WS 未 OPEN 时发送走 REST 队列返回 `{queued:true}`。
7. **会话列表**（`conversation-panel.tsx`）：>1 小时未更新自动落 "older" 折叠桶；六态状态点（完成对勾/运行脉冲/等确认常亮绿/暂停灰/错误红/沙盒缺失归档图标）带 tooltip；置顶/归档独立 persist store。
8. **工具卡确认**：确认按钮挂在**最后一张工具卡之下**（非独立弹窗），`security_risk===HIGH` 时上方红字 RiskAlert；REST 提交 + `submittedEventIds` 防重；⌘↩ 确认 / ⇧⌘⌫ 拒绝。

## 4. 移动端

`use-breakpoint.ts` 布尔态断点（1024/767）只在翻转时重渲染；移动端右侧工作区整个不渲染，改独立全屏路由；侧栏 ≤767 转 hover 预览 compact 图标行。

## 5. 对 ECode 的借鉴结论

双轨事件 store + 原位替换（工具卡状态机最干净的实现）；rAF 批处理（零依赖直接移植）；EventGroup 折叠组（移动端长会话滚动可控的答案）；defineVisualizer 注册表；无依赖 LCS DiffView（ECode 编辑卡不需要 diff 库）。反面：云/本地双后端代理层与第二 WS（连接复杂度放大器）、会话面板 8+ 开关的偏好矩阵（桌面重度产品才养得起）。
