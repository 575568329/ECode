# Web 端调研：NextChat

> 日期：2026-08-30 · 状态：已完成
> 对象：`D:\study\NextChat`（app/ 目录；Next.js 14 仅作构建壳与 API 反代，实际路由为 react-router HashRouter；React18 + Sass + zustand4）。极轻量单页聊天 + 移动 PWA 体验的代表——价值在「轻做法达到近效果」，不在功能广。六份对标分析之六。

## 1. 定位与纠偏

它**并非不用状态库**：zustand4，但只有 78 行的 `createPersistStore` 封装（`app/utils/store.ts`）承担全部模式。对 ECode 的参考意义恰恰是这层「轻做法」清单。

## 2. 技术栈与构建要点

- Next 只为构建链与 `/api/proxy/*` 反代；全站 HashRouter；9 个页面组件 + Markdown 渲染器 + 侧栏列表全部 `next/dynamic` 懒加载；`BUILD_MODE=export` 时 LimitChunkCountPlugin 打成单文件纯静态导出（可离线部署）。
- 微型依赖内联实例：serviceWorker.js 手写内联压缩版 nanoid，避免为一个 ID 引入完整依赖。

## 3. 关键设计（附路径）

1. **rAF 打字机缓冲渲染**（`app/utils/chat.ts:197-221`）：SSE chunk 不直接上屏，进 `remainText` 缓冲；rAF 每帧吐 `max(1, remainText.length/60)` 个字符（网络快吐字快、慢则保底每帧 1 字符），结束一次性追平。配合：消息以 message.id 为 key + `MarkdownContent` memo——重渲染只发生在内容变化的消息；完成后换 key（loading→done）强制一次全量重挂清理流式期 dirty DOM。
2. **`_hasHydrated` 写入门 + version/migrate 链**（`app/utils/store.ts:29-78` + `app/utils/indexedDB-storage.ts`）：zustand persist + idb-keyval（localStorage 降级）；**hydration 完成前 setItem 直接 return，防默认空 state 覆盖用户数据**；每个 store 自带 `version + if (version < X)` 链式迁移；`update(updater)` deepClone 后可变风格写。请求控制独立于 store（`ChatControllerPool` 按 (sessionId,messageId) 存 AbortController）。
3. **3 页窗口分页渲染（无虚拟列表库）**（`app/components/chat.tsx:1386-1429`）：`CHAT_PAGE_SIZE=15`，只渲染 45 条；滚到距顶/底一个视口高时窗口整页换位——约 40 行实现对不等高消息流够用，不破坏浏览器原生滚动与页内搜索。
4. **移动两态纯 CSS 抽屉 + iOS 细节包**：`@media (max-width:600px)` 下侧栏 `left:-100%` + 路由驱动 class + transition（无手势库）；iOS 四件套——移动侧栏 `transition:none`（fix #3016 卡顿）、输入框 `font-size:16px` 防聚焦缩放、body `touch-action:pan-x pan-y` + overflow hidden、viewport `maximumScale=1` 禁双击缩放；中文 IME 三重防护（keyCode 229 + isComposing + composition 事件）；移动禁 autoFocus；SW 双用途（更新即 reload + `/api/cache/*` 劫持为纯客户端文件存储实现图片上传回显）。
5. **删除撤销 toast**（`app/store/chat.ts:337-378`）：删除前 `restoreState` 存闭包，5 秒 toast 点击恢复——零存储成本覆盖 95% 误删场景（无软删除 schema）。同风格小件：未发送草稿按会话写 localStorage（`UNFINISHED_INPUT(session.id)`）；↑ 回填上次输入；复制代码按钮纯 CSS hover 显示；`content-visibility:auto` 渲染优化。

## 4. 其他

- 自动滚动：内部 autoScroll 态 + rAF 滚底；用户 touch 消息区立即停止跟随并 blur 输入框；hitBottom 阈值移动 4px/桌面 10px。
- 上下文用量展示是**文本级**的：标题栏消息数 + PromptToast「已注入 N 条上下文」+ 会话配置里「记忆进度 X of Y」——无 token 仪表盘。
- 会话操作天花板：无置顶/重命名按钮/文件夹/搜索过滤（重命名依赖 LLM summarize）——会话一多不可管理，列表信息架构不可参考。

## 5. 对 ECode 的借鉴结论

轻做法五件：rAF 打字机缓冲（配合 key+memo 即可平滑流式）、persist 水合写入门 + 版本迁移链、窗口分页渲染（虚拟化前的第一档）、移动 iOS 细节包、删除撤销 toast。反面：单级会话模型（无组织能力）、全量 deepClone 持久化（agent 规模必须按会话分 key + 写盘节流）、流式期整条消息全量 re-parse markdown（靠完成后换 key 掩盖，未真解决）。
