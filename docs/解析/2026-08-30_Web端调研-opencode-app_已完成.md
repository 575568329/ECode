# Web 端调研：opencode（packages/app）

> 日期：2026-08-30 · 状态：已完成
> 对象：`D:\study\opencode`（SolidJS 1.9 + Vite7 + bun workspaces + turbo；`packages/client` 为协议生成客户端，`packages/session-ui` 为会话渲染独立包，`packages/desktop` 为 Electron 壳）。本文是 ECode Web 端设计（详设/2026-08-30_后续-Web端设计与升级方案）的六份对标分析之一。

## 1. 定位

与 ECode 最同构的对标：本地 daemon + 单页 Web（另有桌面壳），「一条全局事件流 + 多项目目录路由」的会话 UI。技术栈不同（SolidJS vs React），但事件消费、流式渲染、审批交互三层与 ECode 问题域完全重合。

## 2. 技术栈与架构要点

- 路由 `@solidjs/router`，状态 = `solid-js/store`（produce/reconcile 细粒度更新）+ `@tanstack/solid-query`；无全局状态库，40+ 个 `createSimpleContext` 小上下文按域拆分。
- `packages/client` 由协议契约代码生成（`@opencode-ai/httpapi-codegen`），app 依赖打包 tgz；会话渲染层独立为 `@opencode-ai/session-ui` 包，通过 context 注入平台能力实现「渲染组件可替换」。
- 样式：Tailwind4 + `data-component`/`data-slot` 属性选择器语义 CSS + CSS 变量主题。

## 3. 关键设计（附路径）

1. **SSE 单流「合并-分帧」消费**（`packages/app/src/context/server-sdk.tsx`）：事件入队 → 同 part 连续 delta 拼接 → 16ms 帧 flush（Solid batch 包裹），读取协程每 8ms 让出；重连为 250ms 延迟 generation 化 while 循环，pagehide 停流、pageshow（bfcache）重启。高频 token delta 不击穿渲染帧率。
2. **事件驱动规范化 store**（`src/context/global-sync/event-reducer.ts`）：事件按类型分发，二分定位有序 message/part 数组原地更新（`message.part.delta` 直接拼接），零整段 refetch。
3. **流式 markdown 三段管线**（`packages/session-ui/src/components/markdown-stream.ts` + `markdown.worker.ts` + `markdown.tsx`）：`marked.lexer` 分块投影——完整块按 hash 键控跳过重渲染，仅 live 尾块用 `remend` 修复未闭合语法；shiki 高亮在 Worker 中以 `@shikijs/stream` 产出 stable/unstable 两段 token，主线程只追加尾部 span；DOM 应用用 morphdom（复制按钮 `onBeforeElUpdated` 返回 false 保活）；LRU 200 条缓存 + DOMPurify 消毒。
4. **审批 dock + 两级 auto-accept**（`src/pages/session/composer/session-permission-dock.tsx`、`src/context/permission-auto-respond.ts`）：审批是钉在 composer 上方的 dock 卡（Deny ghost / Allow Always secondary / Allow Once primary），不弹窗；"always" 作用域键 = 会话级 + 目录通配级，授权沿会话父链继承（子代理不重复弹批）。
5. **按目录 refcount 的订阅上下文**（`server-sdk.tsx` `createDirSdkContext` + `createRefCountMap`）：全局一条流，事件按 directory 内存路由，进入项目 = acquire、离开 = release——切项目/会话零重连。
6. **主题 seed→oklch 运行时生成**（`packages/ui/src/theme/resolve.ts`）：主题 JSON 只给 seed 色，运行时生成整套色阶写 CSS 变量；防闪预载脚本内联进 index.html。

## 4. 移动端/PWA

统一断点 768px（JS 态切换）；移动侧栏为 Drawer；PWA 仅可安装清单级（无 SW，不做离线）；`index.html` 的 `interactive-widget=resizes-content` + `viewport-fit=cover` 解决软键盘遮挡（低成本，ECode 可直接抄）。

## 5. 对 ECode 的借鉴结论

SSE 合并-分帧消费模型（框架无关纯 JS，可原样移植）；流式 markdown 的「块投影 + 尾块 remend + Worker 高亮」分层（React 可等价实现）；目录 refcount 订阅；审批 dock 三键层级；auto-accept 父链继承。反面：SolidJS 细粒度响应 ECode 用不上，40+ context 粒度过细。
