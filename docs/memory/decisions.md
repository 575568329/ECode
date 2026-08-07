# 技术决策记录

> 跨设备同步（git 跟踪）。记录关键技术选型 / 架构决策及**推翻原因**——尤其推翻既定决策时，必须记下"为什么改"，否则下次会有人（包括 AI）拿旧结论反驳。
> 索引在 [MEMORY.md](./MEMORY.md)。

---

## 决策 #001：M3 Token 计数用 `length/4` 粗估（推翻原 ai-tokenizer 方案）

**日期**：2026-08-03
**状态**：✅ 已决策（用户拍板）
**影响范围**：M3 上下文管理（token 计数 → 压缩阈值判断）；同步修订 `总纲/00-开发规划.md` / `里程碑/M1-技术选型与理由.md` / `里程碑/M3-实施方案.md` / `里程碑/M3-方案解析.md` / `总纲/里程碑功能流程图.md`

### 原方案（被推翻）

`00-开发规划.md` 原定：**ai-tokenizer 为主**做 token 计数，理由是"跨模型统一计数、准确"。

### 新方案

字符串长度 / 4 粗估 token 数，**不引入任何 tokenizer 库**（ai-tokenizer / tiktoken 都不用）：

| 内容类型 | 估算规则 | 理由 |
|---------|---------|------|
| 普通文本 | `length / 4` | 仿 Claude Code 官方 |
| JSON / JSONL | `length / 2` | 结构化文本 token 密度更高 |
| 图像 | 固定 2000 token | 粗略常量 |

中文场景 `length/4` 会**高估**真实 token → 倾向"早压缩" → 容错方向（宁可提前压，别撑爆）。

### 推翻理由（2026-08-03 源码 + Web 核查后）

1. **ai-tokenizer 对 ECode 默认模型不适用**：ai-tokenizer 主打 OpenAI / Anthropic / Google，对 **GLM / DeepSeek 无原生 encoding**（我原写"覆盖 GLM/DeepSeek"是失真记忆，详见 [debugging.md #004](./debugging.md)）。
2. **官方"≥97% 准确率"声明有水分**：仅针对 GPT-5 / Claude / Gemini 等顶级模型；第三方测评（dev.to jerown）对部分模型仅 37.7% within 10%。
3. **Claude Code 官方就是 `length/4`**：`claude-code-main/services/tokenEstimation.ts:203-208`——生产级 agent 都用粗估，说明够用。
4. **压缩阈值只需"趋势"不需精确值**：阈值是"够不够就触发"的判断，±10% 误差不影响决策。
5. **零依赖**：符合"如无必要勿增实体"。

### 备选（留作后续）

Anthropic 侧可选 `count_tokens` API 校准，但 OpenAI-compatible 侧无统一接口、且多一次网络往返。当前两 provider 统一 `length/4`，Anthropic `count_tokens` 留作后续可选优化。

### 关联

- 方法论教训：[debugging.md #004](./debugging.md)（LLM 既有知识写"具体数值"会失真）
- 实施细节：[M3-实施方案.md](../里程碑/M3-实施方案.md) 决策 1 / [M3-方案解析.md](../里程碑/M3-方案解析.md) §2.2

---

## 决策 #002：Session 同 id = 覆盖（剔除 `-2` 冲突后缀）

**日期**：2026-08-03
**状态**：✅ 已决策（用户拍板：剔除 -2，纯覆盖）
**影响范围**：M3 P4 Session 持久化（`src/session.ts` saveSession + 设计文档 §6.1/§6.9 + 测试）

### 背景

设计文档原定：session 文件名 `${id}_${slug}.json`，**同秒冲突落盘前检测加 `-2`/`-3` 后缀**（§6.1/§6.9）。

### 问题（实施时暴露的内在矛盾）

`saveSession` 收到"同 id 再次落盘"时，无法在内部区分两种场景：
- **续接更新**（§6.5 决策③A）：同一会话 load → 追加新任务 → save，id 相同 → 应**覆盖原文件**（history 连续）。
- **同秒新建冲突**（§6.1）：两个新会话同秒+同 task，id 相同 → 应**加 `-2`**（不丢数据）。

两者输入（同 id、同 slug、文件已存在）完全一样，无外部信号无法区分。且 `-2` 破坏 id 唯一性（`loadSession('id')` 会匹配到两个文件）。

### 新方案

**同 id = 同一会话 = 覆盖**（对齐 Claude Code 纯 id 覆盖语义），不做 `-2`。

### 推翻 `-2` 的理由

1. **与续接覆盖语义矛盾**：saveSession 无法区分续接/新建，`-2` 会破坏 §6.5 决策③A。
2. **`existsSync` 防不了竞态**：两进程并行写，检测都"不存在"→ 都写 → 覆盖；`-2` 只防串行同秒，防不了并行。
3. **场景极罕见**：id 是秒级时间戳，单用户 CLI 同秒+同 task 两个新会话概率极低；即便发生，丢的只是一个刚启动的空会话。
4. **对齐 Claude Code**：CC 用纯 id 命名 `<id>.jsonl`，同 id 天然覆盖，无 `-2`。
5. **YAGNI**：不为极罕见场景增加复杂度。

### 附带实施细化

续接参数从设计文档的 `{ resumedMessages }` 扩展为 `resumed: { id, task, createdAt, messages }`——`task`/`createdAt` 要保持原会话值（§3.4"续接不覆盖首句任务"），runAgent 需这些字段才能正确续写同一文件。不改设计意图（复用 id 续写）。

### 关联

- 实施细节：[M3-实施方案.md](../里程碑/M3-实施方案.md) §6.1 / §6.5 / §6.9（已同步修订）
- 代码：[src/session.ts](../../src/session.ts) saveSession / [src/agent.ts](../../src/agent.ts) ResumeContext
