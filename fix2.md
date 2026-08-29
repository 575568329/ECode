# 问题账清理批 II 任务书（flake 根治+F-09/F-06/F-11+web warn 缺口）

每项完成小结一句；产品码改动配测试。验收见文末。

## 1.（本批主项）批量补 afterEach(cleanup)——flake 家族根治

上批调查结论：跨文件遗留挂载叠加（无 cleanup 的 render 测试文件挂载实例与 flake 文件挂载期工作在共享事件循环叠加掉帧）。任务：
- 扫描 `tests/` 下所有用 ink-testing `render(` 的测试文件，列出缺 `afterEach(cleanup)` 的（上批扫出 30+）；
- 全部补上（import { cleanup } + afterEach(() => cleanup())——已有 afterEach 的文件并入调用；已有 import 的只加调用）；
- **验证本项价值的核心指标**：补完后全量 vitest 连跑 3 次，统计 flake 家族（approvalReason/checkpoint rename/subagent/git.test /undo）红次数——预期显著减少或归零；3 次结果原样汇报（不许只跑一次挑好的）。

## 2. F-09 工具组行标签截断

工具组行标签 "bash" 渲染成 "bas"（截断丢字）。定位 ToolGroupView 标签列宽计算，修截断（加宽/省略号/换行取一——看 CC 对比文档工具展示节的做法，选最小修）。补 1 用例。

## 3. F-06 输出展开历史标记

工具输出展开无轮次/时间标记，历史快照易误读为当前状态。修：展开态头部加轻量标记（如 `轮N · HH:MM`，数据源 recentTools 已有轮次信息则复用，没有则评估加字段成本——若成本大就只加时间戳）。补 1 用例。约束：标记行走 V 线预算（不新增超屏面）。

## 4. F-11 长任务 todo 触发引导

40+ 工具长任务不主动用 todo，用户看不到计划。修：提示词层引导（buildSystemPrompt 的工具指引段加一句「多步任务先用 todo 列计划再动手」，对照 opencode/CC 的 todo 引导措辞选轻量版）。验证：提示词防漂移测试（若有）更新快照。

## 5. web warn 帧消费缺口（监看方已定位）

协议帧 `{type:'warn', text}`（maxIter 耗尽/loop-guard 等 onWarn 走此通道）：TUI 有消费（告警中心），**web/src/store.ts 的帧 switch 只有 error/systemMsg/notice 三 case——warn 落 default 被丢弃，web 用户拿假完成**。修：加 `case 'warn'`（渲染 `⚠ 文本` system 行，参考 notice 的 warn 分支样式）。补 web 测试一例（web/ 独立包 vitest——`cd web && npx vitest run` 或按仓库惯例）。

## 验收

1. 根仓 `npx vitest run` 全量 **3 连跑**（第 1 项的核心验证）+ `npx tsc --noEmit` 净；
2. web 测试绿（若 web 有测试基建）+ web build 不破（`cd web && npm run build`）；
3. TUI 改动面（F-09/F-06 动 ToolGroupView/Conversation）跑 `node scripts/pty-confirm-keyboard-probe.cjs` 确认无回归；
4. 汇报：每项改动文件+用例+**3 连跑的 flake 统计表**（本批最重要的交付数据）。
