# @anthropic-ai/sdk 参数详解

> **版本**: 0.32.1（当前项目锁定）
> **目的**: 记录 SDK 所有关键参数和返回结构，方便逐一实验理解
> **实验建议**: 对照本文档修改 `src/agent.ts` 里的参数，观察 LLM 行为变化

---

## 一、Client 初始化

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: 'sk-ant-...',              // API Key（必填）
  // 以下为可选参数：
  baseURL: undefined,                // API 地址（默认 https://api.anthropic.com）
  maxRetries: 2,                     // 失败重试次数
  timeout: 60000,                    // 请求超时（毫秒）
  anthropicVersion: undefined,       // API 版本（默认使用最新）
  defaultHeaders: undefined,         // 自定义请求头
  dangerouslyAllowBrowser: false,    // 浏览器环境（生产不建议）
});
```

### 参数详解

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `apiKey` | `string` | — | **必填**。从 https://console.anthropic.com/ 获取 |
| `baseURL` | `string` | `https://api.anthropic.com` | 自定义 API 地址。比如通过代理转发时用 |
| `maxRetries` | `number` | `2` | 遇到 500/529 等错误时自动重试次数。设为 0 禁用重试 |
| `timeout` | `number` | `60000` (60s) | 请求超时，单位毫秒。设为 `0` 或 `undefined` 不超时 |
| `anthropicVersion` | `string` | `'2023-06-01'` | API 版本。不传则用最新稳定版 |
| `defaultHeaders` | `Record<string, string>` | `undefined` | 附加的自定义 HTTP 头 |
| `dangerouslyAllowBrowser` | `boolean` | `false` | 浏览器环境需要设为 true（有安全风险） |

---

## 二、messages.create() — 核心 API

```typescript
const response = await anthropic.messages.create({
  // ---- 必填 ----
  model: 'claude-sonnet-4-20250514',   // 模型名（见下方列表）
  max_tokens: 1024,                     // 最大输出 token 数
  messages: [
    { role: 'user', content: '你好' },
  ],

  // ---- 可选 ----
  system: '你是 AI 助手',               // 系统提示词
  tools: [...],                         // 工具定义数组
  tool_choice: { type: 'auto' },       // 工具调用策略
  temperature: 0.7,                     // 温度（0-1）
  top_p: 0.9,                          // 核采样
  top_k: 40,                           // Top-K 采样
  stop_sequences: [],                   // 停止序列
  stream: false,                        // 是否流式
  metadata: { user_id: '...' },        // 用户标识
});
```

---

### 2.1 model — 模型选择

```typescript
model: 'claude-sonnet-4-20250514'
```

当前可用模型（2026-07）：

| 模型 ID | 说明 | 适合场景 |
|---------|------|---------|
| `claude-opus-4-20250514` | Opus 4（最强大） | 复杂推理、代码生成 |
| `claude-sonnet-4-20250514` | Sonnet 4（平衡） | **默认选择**，日常编码 |
| `claude-haiku-4-20250514` | Haiku 4（快速） | 简单任务、快速实验 |
| `claude-3-5-sonnet-20241022` | 旧版 Sonnet | 兼容旧场景 |

> 💡 **实验**: 换不同 model，观察回答质量和速度的区别

---

### 2.2 system — 系统提示词

```typescript
// 字符串形式（常用）
system: '你是一个 AI 编程助手，请用中文回答。'

// 数组形式（可以配多个来源）
system: [
  { type: 'text', text: '你是一个 AI 编程助手。' },
  { type: 'text', text: '当前项目：ECode - 手写 AI Coding Agent' },
]
```

**关键行为**:
- system 永远在上下文的最前面，不进入 `messages` 数组
- token 不计入 API 调用时的输出 token 限制
- 数组形式适合分层拼装（项目配置 + 工具说明 + 用户偏好）

> 💡 **实验**: 不加 system、加简短 system、加长 system，观察 LLM 行为差异

---

### 2.3 max_tokens — 输出上限

```typescript
max_tokens: 4096  // 最大 8192（根据模型不同）
```

**关键行为**:
- 控制 LLM **单次回复**的最大 token 数
- 到达上限会触发 `stop_reason: 'max_tokens'`
- agent loop 中，单次工具调用通常不需要太大

> 💡 **实验**: 设 50、500、4096，看 LLM 回答何时被截断

---

### 2.4 tools — 工具定义

```typescript
tools: [
  {
    name: 'read_file',                 // 工具名（模型靠这个识别）
    description: '读取文件内容...',      // 描述越详细，模型越会用对
    input_schema: {
      type: 'object',                  // 固定
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
      },
      required: ['path'],
    },
  },
]
```

**关键字段**:

| 字段 | 说明 |
|------|------|
| `name` | 工具名，模型通过 name 决定调哪个工具。**建议用 snake_case** |
| `description` | 描述工具做什么。**写详细！** 直接影响模型是否会用这个工具 |
| `input_schema` | 参数定义，**JSON Schema** 格式 |

**`input_schema` 完整示例**:
```typescript
input_schema: {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '文件路径',
    },
    recursive: {
      type: 'boolean',
      description: '是否递归',
      default: false,      // JSON Schema 支持默认值
    },
    maxResults: {
      type: 'number',
      description: '最大结果数',
      minimum: 1,
      maximum: 100,
    },
  },
  required: ['path'],      // 哪些参数必填
}
```

> 💡 **实验**: 改 description 的长短，观察模型会不会"不调用工具"或"错用工具"

---

### 2.5 tool_choice — 工具调用策略

```typescript
// 默认：模型自己决定是否用工具
tool_choice: { type: 'auto' }

// 强制：模型"必须"用某个工具（不能文本回复）
tool_choice: {
  type: 'tool',
  name: 'read_file',        // 指定用哪个工具
}

// 允许：模型"可以"用任何工具（但不能文本回复）
tool_choice: { type: 'any' }
```

| 策略 | 效果 | 适用场景 |
|------|------|---------|
| `{ type: 'auto' }` | 模型自主决定文本回复还是调工具 | **默认**，日常用 |
| `{ type: 'any' }` | 模型必须调某个工具，不能只回文本 | 测试、你想强制用工具时 |
| `{ type: 'tool', name: 'xxx' }` | 强制调**指定的**工具 | 联动场景 |

> 💡 **实验**: 切换三种策略，看 LLM 行为变化
> - `auto`: 可能回文本，也可能调工具
> - `any`: 必须调工具（选哪个由模型决定）
> - `tool`: 只能调指定工具，即使不适用也硬调

---

### 2.6 temperature / top_p / top_k — 随机性控制

```typescript
temperature: 0.0,    // 0~1，越低越确定（编码建议 0）
top_p: 0.9,         // 0~1，核采样阈值
top_k: 40,          // 1~500，只考虑概率前 K 的 token
```

| 参数 | 低值 | 高值 | 编码推荐 |
|------|------|------|---------|
| `temperature` | 保守、可重复 | 创意、发散 | `0`（最大确定性） |
| `top_p` | 聚焦高概率词 | 更多可能性 | `0.9`（默认） |
| `top_k` | 严格限制词表 | 更多候选 | `40`（默认） |

> **注意**: Anthropic 建议不要同时调 temperature 和 top_p，二选一即可
>
> 💡 **实验**: `temperature: 0` vs `temperature: 1`，同样问题答 3 次，看差异

---

### 2.7 stop_sequences — 停止序列

```typescript
stop_sequences: ['</answer>', '```\n\n']
```

- 当 LLM 输出到这些字符串时立即停止
- 不包含停止序列本身
- 常见用途：控制输出格式、提前终止

> 💡 **实验**: 设 `stop_sequences: ['\n']`，看 LLM 是不是只说一行就停了

---

### 2.8 stream — 流式模式

```typescript
stream: true
```

**非流式**（默认）:
```typescript
const response = await anthropic.messages.create({ ... });
// 一次性拿到完整 response.content
```

**流式**:
```typescript
const stream = await anthropic.messages.create({ ..., stream: true });
for await (const event of stream) {
  // event 类型: 'message_start' | 'content_block_start' | 'content_block_delta' | ...
  // 需要自己拼装完整消息
}
```

**M1 暂不实现流式**，原因：
1. 增加代码复杂度，模糊学习焦点
2. tool_use block 在流式结束时才完整
3. M4 混合流式时再实现

> 💡 **实验**: 可以自己试试 stream: true，看 event 结构

---

### 2.9 metadata — 用户标识

```typescript
metadata: {
  user_id: 'user_abc123',   // 自定义用户 ID
}
```

**作用**:
- Anthropic 用于监控和 abuse 检测
- 不影响模型行为
- **不是**用来传自定义数据的

---

## 三、Response 结构

### 3.1 完整返回

```typescript
{
  id: 'msg_01ABCxyz...',      // 消息唯一 ID
  type: 'message',             // 固定 'message'
  role: 'assistant',           // 固定 'assistant'
  content: [                   // 内容块数组（类型见下方）
    { type: 'text', text: '让我读一下文件...' },
    { type: 'tool_use', id: 'toolu_...', name: 'read_file', input: { path: './package.json' } },
  ],
  model: 'claude-sonnet-4-20250514',  // 实际使用的模型
  stop_reason: 'end_turn',     // 终止原因
  stop_sequence: null,         // 触发停止的文本（如有）
  usage: {
    input_tokens: 150,         // 输入 token 数
    output_tokens: 80,         // 输出 token 数
  },
}
```

### 3.2 stop_reason 取值

| 值 | 含义 | 处理方式 |
|----|------|---------|
| `'end_turn'` | LLM 回答完毕 | ✅ 终止循环 |
| `'tool_use'` | LLM 请求调工具 | 🔄 继续循环 |
| `'max_tokens'` | 输出超限截断 | ⚠️ 特殊处理（M1 暂简化处理） |
| `'stop_sequence'` | 触发停止序列 | ✅ 终止循环 |

### 3.3 usage — Token 用量

```typescript
usage: {
  input_tokens: 150,    // 请求中 messages + system + tools 的总 token
  output_tokens: 80,    // 回复中的 token 数
}
```

**注意**: `input_tokens` 包含整个 messages 数组 + tools 定义 + system 提示。agent loop 中 messages 越长，input_tokens 越大。

---

## 四、Content Block 类型

### 4.1 text block

```typescript
// 响应中的文本块
{ type: 'text', text: '这是 LLM 的回复内容' }

// 请求中的文本块
{ type: 'text', text: '用户消息' }
```

### 4.2 tool_use block

```typescript
// 仅在响应（assistant）中出现
{
  type: 'tool_use',
  id: 'toolu_abc123',       // 工具调用 ID（很重要！）
  name: 'read_file',         // 工具名
  input: { path: './package.json' },  // 参数对象
}
```

### 4.3 tool_result block

```typescript
// 仅在请求（user）中出现 —— 你回传工具结果时用
{
  type: 'tool_result',
  tool_use_id: 'toolu_abc123',   // 必须等于上述 tool_use.id
  content: '文件内容...',          // 结果（字符串或 content block 数组）
  is_error: false,                // 工具是否执行失败
}
```

### 数组结构示例

**请求中** — user 消息可以混合多个 block：
```typescript
{
  role: 'user',
  content: [
    { type: 'text', text: '基于以下文件内容，回答我的问题' },  // 文本
    { type: 'tool_result', tool_use_id: 'toolu_1', content: '...' },  // 工具结果
    { type: 'tool_result', tool_use_id: 'toolu_2', content: '...' },  // 另一个
  ]
}
```

**响应中** — assistant 消息同样可以混合：
```typescript
{
  role: 'assistant',
  content: [
    { type: 'text', text: '我先看一下这个文件...' },   // 思考过程
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {...} },  // 调工具
  ]
}
```

---

## 五、错误类型

```typescript
import Anthropic from '@anthropic-ai/sdk';

try {
  const response = await anthropic.messages.create({ ... });
} catch (err) {
  if (err instanceof Anthropic.APIError) {         // 所有 API 错误的基类
    err.status;    // HTTP 状态码
    err.message;   // 错误描述
    err.body;      // 完整错误体
  }
  if (err instanceof Anthropic.AuthenticationError) {   // 401 — API Key 无效
    // 重新生成 key
  }
  if (err instanceof Anthropic.RateLimitError) {        // 429 — 限流
    // 指数退避重试
  }
  if (err instanceof Anthropic.BadRequestError) {       // 400 — 请求参数错误
    // 检查 messages 格式、tool_use id 是否匹配
  }
  if (err instanceof Anthropic.InternalServerError) {   // 500 — 服务端错误
    // 可以重试
  }
}
```

### 常见错误排查

| 错误 | 状态码 | 最常见原因 |
|------|--------|-----------|
| `AuthenticationError` | 401 | API Key 填错或过期 |
| `BadRequestError` | 400 | `tool_result.tool_use_id` 不匹配 |
| `BadRequestError` | 400 | messages 顺序错（user/assistant 交替错） |
| `RateLimitError` | 429 | 请求太快，超过 tier 限制 |
| `InternalServerError` | 500 | Anthropic 服务端问题（等几秒重试） |
| `PermissionDeniedError` | 403 | API Key 没有该模型权限 |
| `NotFoundError` | 404 | 模型名写错 |

---

## 六、实验清单

以下是你可以直接试的参数组合：

### 实验 1：换模型
```bash
ANTHROPIC_MODEL=claude-haiku-4-20250514 npx tsx src/index.ts "讲个冷笑话"
ANTHROPIC_MODEL=claude-opus-4-20250514 npx tsx src/index.ts "写个快速排序"
```

### 实验 2：调温度
在 `src/agent.ts` 里 `messages.create()` 中加一行：
```typescript
temperature: 1.0,  // 试试 0、0.5、1.0，看同样问题回答差异
```

### 实验 3：改 tool_choice
```typescript
// 强制调工具
tool_choice: { type: 'any' },
// 看 LLM 即使能直接回答也必须调工具

// 指定工具
tool_choice: { type: 'tool', name: 'read_file' },
// 看 LLM 如何硬着头皮调 read_file
```

### 实验 4：不加 tools
把 `tools: toolDefinitions` 这行注释掉，看 LLM 只能文本回复

---

## 七、参考链接

- [Anthropic API 官方文档](https://docs.anthropic.com/en/api/messages)
- [@anthropic-ai/sdk GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
- [API 版本说明](https://docs.anthropic.com/en/api/versioning)

---

**创建时间**: 2026-07-28  
**SDK 版本**: 0.32.1  
**关联文档**: `docs/04-OpenAI-vs-Anthropic-API协议对比.md`
