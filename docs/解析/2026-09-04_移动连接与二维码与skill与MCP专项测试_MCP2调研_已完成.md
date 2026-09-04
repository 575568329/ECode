# 2026-09-04 手机连接稳定性/二维码/skill/MCP 专项测试 + MCP2 升级调研

> 状态：已完成（测试+双探针入库 0726e7c；MCP2 调研结论待拍板）
> 范围：移动设备连接稳定性、二维码扫码效果、skill/MCP 全链真机、MCP2 升级方案调研

---

## 一、手机连接稳定性（relay-stability-probe 实测 8/8）

新探针 `scripts/relay-stability-probe.ts`：真实手机等价模拟（经公网 relay nodetime.cn 的 E2EE 数据腿客户端），对生产 daemon 跑全场景。

| 场景 | 结果 | 数据 |
|------|------|------|
| 配对 offer 完整性 | ✅ | secret/钉公钥/relay 段全 |
| E2EE 连接握手 | ✅ | e2ee_hello→ready→auth→ok |
| 基线 20 次 cmd 往返 | ✅ 20/20 | 延迟 min/avg/max = 108/123/203ms（公网往返） |
| 重连风暴 ×10（快速断开重连） | ✅ 10/10 | 无失败无卡死 |
| 沉默 35s（越过控制腿心跳窗） | ✅ | 心跳保活+cmd 仍通 |
| 双设备并发在线 | ✅ | 两腿同时在线、cmd 各自正确路由 |
| 持久 invite 复用 | ✅ | 同 invite 多连接（多设备语义） |
| 压测设备清理 | ✅ | 自动吊销 |

**语义澄清（探针首版断言写错对象后修正）**：fresh 仲裁 4409 只作用于 **daemon 控制腿**（防冒名/重复进程抢位）；手机数据腿是 **maxLegs=8 共存设计**——两台手机同 invite 同时在线是产品语义，relay 日志 `active=2` 实证。

**结论**：移动连接在生产 relay 上稳定性达标，无需产品码改动。

## 二、二维码扫码效果（qr-verify 实测 9/9）

新探针 `scripts/qr-verify.ts`：jsqr 解码回读（等价手机相机扫描）——终端 QR 字符画展开成 RGBA 位图喂解码器。

| 检查 | 结果 |
|------|------|
| A1 终端 QR 可解码（jsqr） | ✅ |
| A2 解码内容 == 配对深链（**逐字节 603B 一致**） | ✅ |
| B1-B4 https / nodetime.cn / /ecode/ / #pairing= | ✅ |
| B5 深链 JSON 字段完整（v/deviceId/secret 48B/钉公钥/relay） | ✅ |
| B6 relay connectUrl 与扫码主机一致 | ✅ |
| C1 无空格/引号字符 | ✅ |

**web 端 QR 代码审查**：qrcode.react `QRCodeSVG` 同一深链 payload（与终端同源 `buildPairingLink`，一致性由 A2 覆盖）；白底黑码高对比、SVG 矢量缩放无损（移动端容器宽度自适应）——扫码效果无产品改动需求。

**已知局限（既有披露）**：深链 603B 使 QR 模块密度较高（v 级版本约 37×37），低质量相机/强反光下首次扫描可能失败——设备面板保留「复制链接」兜底（扫不动用链接打开），语义完备。

## 三、skill 全链真机（✅）

- **手动触发**：真轮次「调用 skill 工具加载 agent-dogfood-monitor」——skill 工具成功加载正文，模型正确报出 SKILL.md 标题（`# 终端 Agent 真机 dogfood 监督法`）
- **安全行为副证**：模型随后试图用 read_file 追读 SKILL.md 被**敏感门拦截**（`~/.ecode/skills/` 在家目录围栏内），模型明确「不会用 bash 等方式绕过拦截」——权限系统行为正确
- **注入面**：系统提示 skill 清单 14 个（~/.agents/skills junction）；项目级 .ecode/skills 空正常
- **/skill-create 流程**：面板链真机可达（对 mock LLM 的「蒸馏失败：起草输出未包含 JSON」是诚实报错）；完整起草→预览→确认流程已有单测覆盖骨架，LLM 起草质量归真机门

## 四、MCP 全链真机（✅ 核心链路通，发现两个体验点）

**环境**：项目级 `.mcp.json`（stdio 型，`@modelcontextprotocol/sdk` 1.30.0 写的最小 demo server，echo+add 两工具）。

| 链路 | 结果 |
|------|------|
| 项目 .mcp.json 检测+批准门 | ✅（未批准→「0/1 已连接」+警告「需要批准后才会连接」；批准卡带摘要） |
| 工具注册（mcp__demo__add/echo 进模型工具面） | ✅ |
| 工具调用全链（模型发起→approval 确认→spawn server→JSON-RPC→结果回传） | ✅ `add(5,7)=12`、`echo("mcp-verify-ok")=echo: mcp-verify-ok @时间戳` |
| MCP 工具审批 | ✅ 非 readonly 默认走确认；零应答者按新文案如实拒绝（`APPROVAL_NO_CHANNEL_FEEDBACK` 真机生效） |
| 连接失败恢复 | ✅ server 路径错误时 failed 状态机+60s 退避，修好路径后自动重连成功 |

**发现的体验点（记录，非阻断）**：
1. stdio server 脚本依赖解析遵循 Node 规则（从脚本位置向上找 node_modules）——`.mcp.json` 里引用外部路径的 server 时，依赖必须在 server 脚本侧可达。属 MCP 生态固有行为，建议自部署指南补一句说明。
2. 首次批准门触发时机=宿主首订阅（daemon 常驻下 web/TUI 打开项目页即触发）——协议驱动测试订阅前 gate 已被消费属测试时序问题，产品无碍。

## 五、MCP2 升级调研（结论：**不建议现在升，建议按能力面渐进采纳**）

**现状盘点**：
- SDK **1.30.0**（2025 末版本，已内建 MCP「2025-06-18」规范全量传输：stdio/StreamableHTTP/SSE/WebSocket 四种 client transport）
- ECode 当前接入面：**只用 tools**（listTools+callTool），传输已双支持（stdio + StreamableHTTP）；`type: 'stdio' | 'http'` 配置即对应
- 未接入的 MCP 规范能力：resources（资源订阅）、prompts（服务端提示词模板）、sampling（服务端反呼 LLM）、elicitation（服务端反呼用户输入）、roots、completion、logging

**「MCP2」实际是什么**：社区语境的 MCP2 通常指 2025-06-18 规范（原称 "MCP 2.0" 的 Streamable HTTP 替代 HTTP+SSE、OAuth 2.1 授权、elicitation 等增量）。**ECode 的 SDK 1.30 已完整实现该规范**——不存在「协议版本升级」问题，只有「能力面采纳」问题。

**建议（按价值排序）**：
1. **不建议**做「协议栈升级」——已在新规范上，改无可改
2. **可选采纳 A（低成本高价值）**：`resources` 只读订阅（如 filesystem MCP 的文件资源挂 /context）——预计 2-3 人天，收益取决于用户是否用资源型 server
3. **可选采纳 B（中成本）**：`prompts` 模板接入斜杠命令面（server 提供的 prompt 变成 /命令）——2-3 人天
4. **不建议现在做**：sampling/elicitation（服务端反呼用户/LLM 与 ECode 的审批/插话架构有语义冲突，需专门设计；且生态内 server 使用率低）
5. **顺手项**：`type: 'http'` 已支持但文档未提——自部署指南补一段（对接受众是远程 MCP server 用户）

**决策点留给用户**：是否采纳 resources/prompts 能力面（A/B），还是保持 tools-only（当前所有已知 MCP server 场景已覆盖）。

## 六、交付

- 探针入库：`scripts/relay-stability-probe.ts`（8 断言）、`scripts/qr-verify.ts`（9 断言）——均可复跑作回归哨兵
- 提交 `0726e7c` 已推送
- 产品码零改动需求（连接稳定性与 QR 扫码效果达标；skill/MCP 核心链路通）
