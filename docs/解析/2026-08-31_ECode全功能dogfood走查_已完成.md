# ECode 全功能 Dogfood 走查报告

> 日期：2026-08-30 晚 ~ 08-31 凌晨（本地时间）
> 基线：master 前沿 `006cd94`（feat/m1-heart），dist 与 web/dist 均较源码新鲜，全局 `ecode` 命令跑 dist。
> 方法：agent-dogfood-monitor 双模——pty 驱动 TUI 交互专项（`%TEMP%\ecode-dogfood\driver-sb.cjs`，沙箱项目 cwd）+ serve 事件驱动（serve-watch 自动应答）+ Playwright 走 Web UI + 五个探针哨兵复跑。
> 测试沙箱：`%TEMP%\ecode-dogfood\sandbox`（git 仓库 + ECODE.md + 带 bug 的 calc.js），全程不污染 ECode 仓库与用户配置。

## 一、结论

**27 项能力面验证通过，3 个真实缺陷入库（1 P0 + 2 P1），4 个 P2 观察项。** 核心 AgentLoop、审批与安全门、checkpoint/rewind、压缩、serve/web 多端、探针哨兵全部健康；P0 在单次模式（`ecode "任务" --yes`）的审批链路上，P1 之一是旧「流式轮楔死」销案后以**新形态**重现（现有哨兵存在盲区）。

## 二、缺陷台账（用户遭遇先行）

### D1（P0）单次模式 `--yes` 完全失效，工具审批挂起导致进程静默退出

- **用户遭遇**：按 `--help` 承诺执行 `ecode "任务" --yes`，任务含任何需审批的工具（如 bash）时——没有答案、没有报错、退出码 0。脚本/管道形态全灭，且**静默**（exit 0 伪装成功），排查无从下手。不带 `--yes` 同样死法。
- **复现**：3/3（`ecode "运行命令 …" --yes` 与 `ecode --yes "…"` 两种参数序均复现）。
- **机理**（M12-B1 argv 宿主化回归）：
  1. `runOnce`（src/cli/index.ts:66）把 stdout 适配器 `host.subscribe` 进 channel——**单次模式永远存在订阅者**；
  2. `ApprovalBroker.confirm` 的快速放行要求 `!hasSubscriber && policy==='auto-approve'`（src/host/approval.ts:112）——`hasSubscriber` 恒真，快速放行永不可达；
  3. 无订阅者的 fail-closed 拒绝分支（L124）同样不可达；
  4. 于是走 `suspendOnce` 挂起等待应答——无人应答、`unref()` 的 900s 超时定时器不占事件循环，Node 事件队列清空 → **exit 0**。
- **证据**：沙箱日志事件流 `tool/invoke → approval/asked → system/shutdown`（无 decided）；会话历史停在 assistant tool_use（无 tool_result 无续轮）；stdout 仅 `⏺ bash` + tokens 行。
- **修法方向**：单次模式引入「非交互应答面」语义——`policy==='auto-approve'` 时 tool-confirm 直接放行（不依赖订阅者计数）；ask 策略下无订阅者应 fail-closed 拒绝（resolve(false) 喂回模型继续），或 runOnce 用不计入订阅者的被动订阅。`dispose()` 兜底悬挂 Promise（approval.ts:356）在退出前未被调用到也是链条一环。

### D2（P1）双击 Esc 不再弹出 /rewind 面板

- **用户遭遇**：文档与提示承诺的「空闲态双击 Esc 直达 /rewind」无响应；/rewind 命令路径一切正常（面板、快照点列表、还原清单、回退全部可用），坏的只是触发路径。
- **复现**：4/4（空闲态、会话非空、输入行空、checkpoint 已存在、@ 下拉关闭——守卫条件全部满足仍不触发）。70ms 与 ~400ms 两种间隔均试。
- **定位**：触发实现在 TuiApp.tsx:1132-1144（`lastEscRef` 500ms 窗口 + `deps.checkpoint != null` 守卫）。0828 界面批引入、当时探针过；0830 各批（F-47~F-50、四角色审阅修复、W 线）之后失效，回归窗口在此间。
- **备注**：同批「废 Ctrl+O·E」（F-50）是**有意拆除**（TuiApp.tsx:1090 注释「仅入口拆除」），与 D2 无关但造成折叠提示仍引用 Ctrl+O（见 D7）。

### D9（P1）TUI 硬楔死新形态：多轮审批会话中轮间失联，中断不收敛

- **用户遭遇**：/doctor 多步任务跑到第 3 轮后界面永久「思考中」，Ctrl+C 两次均无法中断，只能杀进程——进行中的工作全部悬空。
- **时间线**（沙箱日志，UTC）：
  - 16:35:46 sensitive read_file `approval/decided(once)` + `tool/result`——**最后一条工具事件**；
  - 之后应出现的 `loop/iter_start`、`provider/request` 均未发生——轮间空档挂死，不是 LLM 慢；
  - 16:42:39 与 16:48:07 两次 Ctrl+C：各留 `interrupt_latency_probe pressed/received` 两阶段痕迹，**无任何收敛事件**；日志 7 分钟零写入，UI 冻结在处理中。
- **定性**：旧「TUI 流式轮楔死」（2026-08-27 复测未复现销案）的新形态——本次挂在**sensitive 审批后的轮间**而非流式中。现有 `pty-wedge-probe` 用 mock SSE，场景**不含审批卡**，对这类盲区无感知；建议哨兵增加「多轮 + sensitive 审批混合」场景与「中断必须在 N 秒内收敛」硬断言。
- **取证**：沙箱 `.ecode/logs/2026-08-30T15-50-31-892Z.jsonl` 全程保留；raw-sb.log 18MB。

### P2 观察项

- **D3** 带搜索的面板（告警中心等）Esc 需两击（第一击清搜索、第二击关闭），与提示行「Esc 返回」不完全一致；且 conpty 增量重绘会让面板状态在观察快照里「似关实开」——排查 TUI 状态时勿只信单帧快照。
- **D4** 历史会话跨项目混列（TUI /history 与 Web 会话列表同现）：旧版会话文件 `meta.cwd === undefined`（字段引入前的数据），cwd 过滤只能放行。数据兼容缺口，可选修法：无 cwd 归档单独「未归属」分组。
- **D5** /model 面板与状态栏只显模型名，同名模型跨 provider 不可辨；且光标起点=当前项，相对移动易选错（本次实测切错一次，切到无 key 的 provider 若继续用会 401）。
- **D7** 工具折叠提示「Ctrl+O 展开」引用 F-50 已废除的键，过期文案。
- **工具坑账（非产品）**：连发退格两发吞一发（Ink 输入层合并），pty 驱动需 ≥0.4s 间隔；node-pty conpty 伴随进程退出时 `AttachConsole failed` 堆栈（notify-probe 日志所见）属 pty 基建噪音，不影响探针结论。

## 三、验证通过清单（27 项）

| # | 能力面 | 实证要点 |
|---|--------|----------|
| 1 | CLI 形态 | `--help`/`--version`/REPL/单次纯文本轮（token 计账含 cacheRead，9.4s） |
| 2 | @ 路径补全 | 行首触发下拉、前须空白门（紧贴单词不弹）、↓ 选择、Tab 补全 |
| 3 | Tab 五档沙箱 | 徽标四态（⏵⏵ edits/⛔ read-only/⏵⏵ write/⚠⏵⏵⏵ full-access）、提档过 `sandbox/set` 审批卡、循环回 default |
| 4 | 审批卡交互 | diff 预览、y/n、**[A] 本会话记住**（edit_file 直放、bash 不被 remember 覆盖）、r 理由模式、Ctrl+T 全文提示 |
| 5 | Ctrl+R 历史搜索 | 独占态、输入即过滤（〔1/1〕）、回车回填；↑↓ 历史回溯；回填态 Esc 清空 |
| 6 | 双击 Ctrl+C | 退出守卫（「再按一次 Ctrl+C 退出」随即解除） |
| 7 | Ctrl+T 全屏查看器 | 空会话 L1-L0/0、跟随模式、操作提示行完整 |
| 8 | 斜杠命令面 | /help（21 命令）/cost/stats/warnings/undo/history/model/config/mcp/skill/plugin/output/sandbox/setup 全走查；两段式执行语义符合文档 |
| 9 | /stats 统计 | 194 会话聚合、按天/模型/项目/最贵会话、缓存命中 97.4%、MCP 计数、未收录定价警告 |
| 10 | /undo 安全 | trailer 校验拒绝退用户提交（「绝不回退用户自己的提交」）并指路 /rewind |
| 11 | /model 切换 | 面板列出 provider×模型、当前标记、状态栏 chip 联动；**会话级不落盘**（config default 未被污染） |
| 12 | /config 面板 | 三页签翻页、Providers 只读（**key✓/key✗ 校验准确**：astron 空串判 ✗）、高级页逃生口 |
| 13 | /mcp /skill /plugin | 懒加载缓存态（demo 已缓存 2 工具）、skill 用户级+内置分组、插件市场空态 |
| 14 | 工具执行 | read/bash/edit/ls 真实轮；**readonly 并行**（4 个 ls 同刻 Promise.all）；工具组折叠渲染 |
| 15 | skill 双触发 | 模型主动调 Skill 工具加载 ecode-config 手册（5.7KB 注入）；斜杠 /skill 面板另一面 |
| 16 | todo 工具 | /doctor 自建 8 项清单，TodoPanel 常驻渲染（◆ 0/8、[->] 当前项） |
| 17 | ECODE.md 注入 | 模型零读文件答中沙箱 ECODE.md 所述 bug（除零） |
| 18 | ctx 计量与压缩 | 状态栏 ctx 4k→8.5k 随轮增长；/compact 后 8.5k→**4.7k 真实释放** |
| 19 | blockedCommands | `git push --force` **exec 层硬拒**：审批 y 也拦不下（is_error=true），模型自述「即使 full-access 也不放行」——与 /sandbox 面板语义一致 |
| 20 | sensitive 门 | read_file 触及 config.json / MEMORY.md 一致拦截（kind:"sensitive" 帧）；bash 绕道读属 D6 已知边界（bash 卡即审批面） |
| 21 | 拒绝理由喂回 | r+理由拒绝，日志 `message` 字段原文透传，模型收到后改道并诚实说「无法给出确定值」 |
| 22 | 插话（M11） | 忙碌输入→「（已排队 · Ctrl+U 清空）」；中断后信封留痕进 transcript（「用户在任务执行中发来新消息…」）；Ctrl+C 不弃队列 |
| 23 | 中断（正常路径） | 长任务轮 Ctrl+C：bash ✗「命令被中断」+「已中断，内容已保留」（异常形态见 D9） |
| 24 | checkpoint //rewind | 5 快照点（bash 与 edit 都 snapshot）；还原清单确认；**文件真回退**（calc.js diff 验证还原到带 bug 版）；对话截断语义提示准确 |
| 25 | serve 协议层 | daemon 起+server.json token、Bearer 401 面、/api/projects（registered+history 五项目）、session/new+prompt `routed:"Started"` 信封、mux 单流帧、轮完成验收（13.4s/0 审批/¥0.0034）、`serve stop` 干净退出 |
| 26 | Web UI | token 门页→两级列表（今日/昨日/更早分组+重命名/归档/搜索/已归档入口/+新对话/添加项目）→hash 深链 /s/<id>→真轮渲染（**markdown 表格**/行内代码/工具 chip/复制/重发）→**审批 dock**（拒绝/允许，composer 保持可用）→插话式 composer（「运行中——输入将作为插话注入」+停止键）→StatsPanel（四指标+三维 breakdown） |
| 27 | 探针哨兵 4+1 | wedge（4 轮含 80-delta+3 次轮末探针）✓；overscreen（全程无 ESC[3J 硬指标+/output 面板场景）✓；grid-check 四项 ✓；notify 六项 ✓；restart（/restart 后新实例输入活）✓ |

## 四、未覆盖面（如实记录）

- 飞书 IM 真机链路（需真机触发，此前 G-IM 门已过，本次未重跑）；
- 图片/PDF 多模态输入（本次未造样张；0829 拆视觉门后真机读图已验过）；
- MCP 工具真实调用轮（demo echo 已缓存但模型未调用其工具）；
- /clear（TUI 被 D9 楔死打断未测）、/skill-create 蒸馏流、/setup 完整重配向导、auto-memory 写入观察、LSP 接口位。

## 五、修复优先级建议

1. **D1（P0）**：单次模式审批链路——影响脚本化核心承诺，修法方向明确（订阅者语义与策略判定解耦），改动面小。
2. **D9（P1）**：先加哨兵场景（多轮+sensitive 卡+中断收敛断言）锁住复现，再定位轮间挂点（`tool/result` 与下一 `iter_start` 之间的 await 链）。
3. **D2（P1）**：双击 Esc 触发回归，二分 0830 各提交可快速定位。
4. P2 四项（D3/D4/D5/D7）随批顺手清。

## 六、修复记录（2026-08-31 实施回填）

| 项 | 状态 | 修法与验证 |
|---|------|-----------|
| D1（P0） | **已修** | runOnce 的 stdout 适配器改观察型订阅（`canAnswer:false`，复用 M14-C2⑧ 通道语义——`hasSubscriber` 回归「真应答者」计数）。E2E 双路径实证：`--yes` 工具轮放行出答案；无 `--yes` fail-closed 拒绝喂回模型继续回答。契约测试 `tests/host/passive-subscriber.test.ts` |
| D9（P1） | **已修（双保险）** | 根因落定：并行只读批次两张 sensitive 卡同刻挂起，TUI 审批卡单槽被后帧顶掉且不再渲染，未应答挂起悬空至 900s 审批超时（当时我杀进程时距自愈仅约 1 分钟）。修复=①宿主级 `enqueueConfirm` 串行队列（同 M11 子代理桥先例，同一时刻至多一张卡）；②broker 挂起接受当轮 AbortSignal，中断即 fail-closed 收敛（Ctrl+C/loop-guard abort 不再被卡拖住）。单测 `tests/host/approval-serialize.test.ts`（串行序+中断收敛 2/2）；新探针 `scripts/pty-sensitive-cards-probe.cjs`（答卡一→卡二必须出现 3/3） |
| D2（P1） | **已修** | 根因：InputStream 挂载期注册的 @ 下拉端口是**常驻活对象**（永非 null），TuiApp 消费端误写 `port !== null` → `escGuarded` 恒真 → 双击 Esc 永久失效。修为持端口、事件时刻 `read()` 取活值。新探针 `scripts/pty-doublesc-probe.cjs` 5/5（单击不开/双击开/Esc 关/草稿守卫/清草稿恢复） |
| D4（P2） | **已修** | 根因比走查报告的「数据兼容缺口」更深：`normalizeProjectPath('')` 内 `realpathSync('')` 解析到 **lister 的 process.cwd()**，恰为过滤目标时全部无主旧会话误命中（当时 TUI cwd=沙箱 → 混列）。修为 `m.cwd !== undefined` 先行排除。回归测试入 `tests/services/history.test.ts`（worker 禁 chdir，以测试进程自身 cwd 构造同条件）；新 dist 真机 /history 复验只剩本项目会话 |
| D7（P2） | **已修** | 折叠提示改「/output 查看全文」（Ctrl+O 已随 F-50 废除） |
| D3 / D5（P2） | 维持现状 | D3 面板首 Esc 清搜索属回填态清空惯例（与 CC 一致），不改语义；D5 状态栏只显模型名的辨识问题留待产品化线随 model chip 一并考虑 |

全量门：vitest **1642 passed + 3 skipped**（149 文件）、tsc 净、dist 重建、探针复跑 doublesc 5/5 + sensitive-cards 3/3 + wedge 4 轮 + grid-check 4/4 + overscreen 无 3J、E2E `--yes`/ask 双路径 + /history 真机复验全过。

## 七、走查环境留痕

- 驱动与产物：`%TEMP%\ecode-dogfood\`（driver-sb.cjs / raw-sb.log / snapshot-sb.log / sent-sb.log / view-sb.cjs / webtoken.txt）；
- 沙箱项目：`%TEMP%\ecode-dogfood\sandbox`（git 仓库，calc.js 停在 rewind 后的未修复态，可复跑 D 系列场景）；
- 取证日志：沙箱 `.ecode/logs/2026-08-30T15-50-31-892Z.jsonl`（含 D9 完整事件链）；
- 本次真 LLM 成本：约 ¥0.05（glm-5.3-flash，12+ 轮）。
